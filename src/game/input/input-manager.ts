import type { PlayerSlot } from '../core/types'
import { ACTION_BIT, INPUT_ACTIONS, MENU_BIT, type InputFrame } from './actions'
import {
  AXIS_BASE,
  PAD,
  axisCode,
  defaultControls,
  type ControlsConfig,
  type DeviceRef,
  type GamepadCode,
  type KeyCode,
  type PlayerControls,
} from './bindings'

const MAX_PADS = 4
const MAX_BUTTONS = 32
const MAX_AXES = 8
const CODE_SPACE = AXIS_BASE + MAX_AXES * 2
const MENU_AXIS_THRESHOLD = 0.5

class PadState {
  connected = false
  id = ''
  /** 'standard' when the browser maps the pad to the Xbox-style layout */
  mapping = ''
  readonly held = new Uint8Array(CODE_SPACE)
  /** went down since the last endTick() */
  readonly pending = new Uint8Array(CODE_SPACE)
  /** menu-strength axis directions (threshold independent of the dead zone) */
  readonly menuHeld = new Uint8Array(4)
  readonly menuPending = new Uint8Array(4)
  /**
   * Inputs that were already active when the pad appeared (stuck triggers,
   * phantom/virtual devices, axes resting off-centre). Ignored until released.
   */
  readonly masked = new Uint8Array(CODE_SPACE)
  /** next sample is the first one after connecting */
  fresh = true

  reset(): void {
    this.held.fill(0)
    this.pending.fill(0)
    this.menuHeld.fill(0)
    this.menuPending.fill(0)
    this.masked.fill(0)
    this.fresh = true
  }
}

/** Which kind of device was pressed last — for on-screen button prompts. */
export type PromptStyle = 'keyboard' | 'xbox' | 'playstation'

export interface GamepadInfo {
  index: number
  id: string
}

/** Live device state for the input tester on the Controls screen (UI only). */
export interface InputDebugInfo {
  keys: KeyCode[]
  pads: { index: number; id: string; standard: boolean; pressed: GamepadCode[] }[]
}

type CaptureRequest =
  | { kind: 'keyboard'; resolve: (code: KeyCode | null) => void }
  | { kind: 'gamepad'; padIndex: number | null; resolve: (code: GamepadCode | null) => void }

/** Keys the browser should not act on while the game has focus. */
const ALWAYS_PREVENT = new Set<KeyCode>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'Backspace'])

const MENU_KEYS_CONFIRM: readonly KeyCode[] = ['Enter', 'NumpadEnter', 'Space']
const MENU_KEYS_BACK: readonly KeyCode[] = ['Escape', 'Backspace']
const MENU_KEYS_NAV: readonly (readonly [KeyCode, number])[] = [
  ['ArrowUp', MENU_BIT.up],
  ['ArrowDown', MENU_BIT.down],
  ['ArrowLeft', MENU_BIT.left],
  ['ArrowRight', MENU_BIT.right],
]

/**
 * Single owner of raw device state (keyboard + Gamepad API).
 * Translates devices into InputAction masks per player using ControlsConfig.
 * Nothing outside src/game/input touches KeyboardEvent or navigator.getGamepads().
 */
export class InputManager {
  controls: ControlsConfig = defaultControls()

  private readonly keysHeld = new Set<KeyCode>()
  private readonly keysPending = new Set<KeyCode>()
  /** on-screen touch buttons (phones): action bits, they drive player 1 */
  private touchHeld = 0
  private touchPending = 0
  private readonly pads: PadState[] = Array.from({ length: MAX_PADS }, () => new PadState())
  private readonly listeners = new Set<() => void>()
  /** at least one connected pad uses the standard (Xbox-style) mapping */
  private anyStandardPad = false
  /** device family pressed most recently (button prompts follow it) */
  private lastStyle: PromptStyle = 'keyboard'

  get promptStyle(): PromptStyle {
    return this.lastStyle
  }
  private capture: CaptureRequest | null = null
  private attached = false

  attach(): void {
    if (this.attached) return
    this.attached = true
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('gamepadconnected', this.onPadEvent)
    window.addEventListener('gamepaddisconnected', this.onPadEvent)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('gamepadconnected', this.onPadEvent)
    window.removeEventListener('gamepaddisconnected', this.onPadEvent)
  }

  /** Subscribe to gamepad connect/disconnect. Returns an unsubscribe function. */
  onDevicesChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  listGamepads(): GamepadInfo[] {
    const out: GamepadInfo[] = []
    this.pads.forEach((p, index) => {
      if (p.connected) out.push({ index, id: p.id })
    })
    return out
  }

  debugInfo(): InputDebugInfo {
    const pads: InputDebugInfo['pads'] = []
    this.pads.forEach((p, index) => {
      if (!p.connected) return
      const pressed: GamepadCode[] = []
      for (let c = 0; c < CODE_SPACE; c++) if (p.held[c]) pressed.push(c)
      pads.push({ index, id: p.id, standard: p.mapping === 'standard', pressed })
    })
    return { keys: [...this.keysHeld], pads }
  }

  isDeviceConnected(ref: DeviceRef): boolean {
    if (ref.kind === 'keyboard') return true
    if (ref.kind === 'none') return false
    return this.resolvePad(ref) >= 0
  }

  // ---------------------------------------------------------------- polling

  /** Read the Gamepad API. Call once per animation frame. */
  poll(): void {
    const list = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    let changed = false
    const dz = this.controls.deadzone
    for (let i = 0; i < MAX_PADS; i++) {
      const gp = list[i] ?? null
      const st = this.pads[i]
      if (!st) continue
      if (!gp || !gp.connected) {
        if (st.connected) {
          st.connected = false
          st.reset()
          changed = true
        }
        continue
      }
      if (!st.connected || st.id !== gp.id) {
        st.connected = true
        st.id = gp.id
        st.reset()
        changed = true
      }
      st.mapping = gp.mapping
      const nb = Math.min(gp.buttons.length, MAX_BUTTONS)
      for (let b = 0; b < nb; b++) {
        const btn = gp.buttons[b]
        this.setPad(st, b, btn !== undefined && (btn.pressed || btn.value > 0.5))
      }
      const na = Math.min(gp.axes.length, MAX_AXES)
      for (let a = 0; a < na; a++) {
        const v = gp.axes[a] ?? 0
        this.setPad(st, axisCode(a, false), v < -dz)
        this.setPad(st, axisCode(a, true), v > dz)
      }
      st.fresh = false
      // menu directions from the left stick with a fixed threshold
      const x = gp.axes[0] ?? 0
      const y = gp.axes[1] ?? 0
      this.setMenuAxis(st, 0, y < -MENU_AXIS_THRESHOLD)
      this.setMenuAxis(st, 1, y > MENU_AXIS_THRESHOLD)
      this.setMenuAxis(st, 2, x < -MENU_AXIS_THRESHOLD)
      this.setMenuAxis(st, 3, x > MENU_AXIS_THRESHOLD)

      if (this.capture?.kind === 'gamepad' && (this.capture.padIndex === null || this.capture.padIndex === i)) {
        for (let c = 0; c < CODE_SPACE; c++) {
          if (st.pending[c]) {
            const cap = this.capture
            this.capture = null
            st.pending.fill(0)
            cap.resolve(c)
            break
          }
        }
      }
    }
    this.anyStandardPad = this.pads.some((p) => p.connected && p.mapping === 'standard')
    if (changed) this.listeners.forEach((cb) => cb())
  }

  /**
   * Pads that count when reading "any gamepad". When a standard-mapped pad is
   * present, non-standard ones are almost always raw duplicates of the same
   * controller (Steam / DS4Windows) with a different button layout — skip them.
   */
  private usable(st: PadState | undefined): st is PadState {
    return st !== undefined && st.connected && (st.mapping === 'standard' || !this.anyStandardPad)
  }

  /** A gamepad seat reads every pad unless the other seat is on a gamepad too. */
  private seatUsesAllPads(slot: PlayerSlot): boolean {
    return this.controls.players[slot === 0 ? 1 : 0].device.kind !== 'gamepad'
  }

  /** Is the seat's device present? (all-pads seats: any usable pad) */
  isSeatConnected(slot: PlayerSlot): boolean {
    const dev = this.controls.players[slot].device
    if (dev.kind === 'gamepad' && this.seatUsesAllPads(slot)) return this.pads.some((p) => this.usable(p))
    return this.isDeviceConnected(dev)
  }

  private readPads(pc: PlayerControls, out: InputFrame, only: number): void {
    for (let i = 0; i < MAX_PADS; i++) {
      const st = this.pads[i]
      if (only >= 0 ? i !== only || !st?.connected : !this.usable(st)) continue
      if (!st) continue
      for (const action of INPUT_ACTIONS) {
        const bit = ACTION_BIT[action]
        for (const code of pc.gamepad[action]) {
          if (st.held[code]) out.held |= bit
          if (st.pending[code]) out.pressed |= bit
        }
      }
    }
  }

  /** An on-screen touch button went down / up (`bit` from ACTION_BIT). */
  setTouch(bit: number, down: boolean): void {
    if (down) {
      if (!(this.touchHeld & bit)) this.touchPending |= bit
      this.touchHeld |= bit
    } else this.touchHeld &= ~bit
  }

  /** Forget edges once they were consumed by a simulation tick / menu frame. */
  endTick(): void {
    this.keysPending.clear()
    this.touchPending = 0
    for (const p of this.pads) {
      p.pending.fill(0)
      p.menuPending.fill(0)
    }
  }

  // --------------------------------------------------------------- players

  readPlayer(slot: PlayerSlot, out: InputFrame): void {
    out.held = 0
    out.pressed = 0
    if (slot === 0) {
      out.held |= this.touchHeld
      out.pressed |= this.touchPending
    }
    const pc = this.controls.players[slot]
    const dev = pc.device
    if (dev.kind === 'keyboard') {
      for (const action of INPUT_ACTIONS) {
        const bit = ACTION_BIT[action]
        for (const code of pc.keyboard[action]) {
          if (this.keysHeld.has(code)) out.held |= bit
          if (this.keysPending.has(code)) out.pressed |= bit
        }
      }
    } else if (dev.kind === 'gamepad') {
      if (this.seatUsesAllPads(slot)) this.readPads(pc, out, -1)
      else {
        const only = this.resolvePad(dev)
        if (only >= 0) this.readPads(pc, out, only)
      }
    }
  }

  /**
   * Single-player input: the slot's keyboard bindings plus every connected
   * gamepad, all at once (used for player 1 against the AI).
   */
  readPlayerAnyDevice(slot: PlayerSlot, out: InputFrame): void {
    out.held = 0
    out.pressed = 0
    const pc = this.controls.players[slot]
    for (const action of INPUT_ACTIONS) {
      const bit = ACTION_BIT[action]
      for (const code of pc.keyboard[action]) {
        if (this.keysHeld.has(code)) out.held |= bit
        if (this.keysPending.has(code)) out.pressed |= bit
      }
    }
    this.readPads(pc, out, -1)
    out.held |= this.touchHeld
    out.pressed |= this.touchPending
  }

  /**
   * Two seats can never share one gamepad: if they do (e.g. after a solo game),
   * player 2 falls back to the keyboard. Returns true if something changed.
   */
  ensureDistinctDevices(): boolean {
    const [p1, p2] = this.controls.players
    const a = p1.device
    const b = p2.device
    if (a.kind !== 'gamepad' || b.kind !== 'gamepad') return false
    const ia = this.resolvePad(a)
    const same = ia >= 0 ? ia === this.resolvePad(b) : a.index === b.index
    if (!same) return false
    p2.device = { kind: 'keyboard' }
    return true
  }

  /** Menu actions pressed this frame by a player's assigned device. */
  readMenu(slot: PlayerSlot): number {
    const pc = this.controls.players[slot]
    const dev = pc.device
    if (dev.kind === 'keyboard') {
      if (!this.isKeyboardOwner(slot)) return this.keyboardMenuFor(pc)
      // arrows belong to the other player when both share the keyboard
      const shared = this.controls.players[slot === 0 ? 1 : 0].device.kind === 'keyboard'
      return this.keyboardMenuFor(pc) | this.globalKeyboardMenu(!shared)
    }
    if (dev.kind === 'gamepad') {
      if (this.seatUsesAllPads(slot)) {
        let m = 0
        for (const p of this.pads) if (this.usable(p)) m |= this.padMenu(p)
        return m
      }
      const st = this.pads[this.resolvePad(dev)]
      return st ? this.padMenu(st) : 0
    }
    return 0
  }

  /** Menu actions pressed this frame on any device (single-cursor menus). */
  readMenuAny(): number {
    let mask = this.globalKeyboardMenu()
    mask |= this.keyboardMenuFor(this.controls.players[0])
    mask |= this.keyboardMenuFor(this.controls.players[1])
    for (const p of this.pads) if (this.usable(p)) mask |= this.padMenu(p)
    return mask
  }

  /** Index of a connected pad on which any button was pressed this frame, or -1. */
  padWithAnyPress(): number {
    for (let i = 0; i < MAX_PADS; i++) {
      const p = this.pads[i]
      if (!this.usable(p)) continue
      for (let c = 0; c < MAX_BUTTONS; c++) if (p.pending[c]) return i
    }
    return -1
  }

  /** Indexes of all connected pads with a button pressed this frame (menus only). */
  padsPressed(): number[] {
    const out: number[] = []
    for (let i = 0; i < MAX_PADS; i++) {
      const p = this.pads[i]
      if (!this.usable(p)) continue
      for (let c = 0; c < MAX_BUTTONS; c++) {
        if (p.pending[c]) {
          out.push(i)
          break
        }
      }
    }
    return out
  }

  /** Enter / Space went down this frame. */
  keyboardConfirmPressed(): boolean {
    for (const c of MENU_KEYS_CONFIRM) if (this.keysPending.has(c)) return true
    return false
  }

  /** True if any keyboard key went down this frame. */
  keyboardAnyPressed(): boolean {
    return this.keysPending.size > 0
  }

  /** True if any key from the slot's keyboard bindings was pressed this frame. */
  keyboardPressedFor(slot: PlayerSlot): boolean {
    const kb = this.controls.players[slot].keyboard
    for (const action of INPUT_ACTIONS) {
      if (action === 'pause') continue // Esc means "back" in menus, not "this is my keyboard"
      for (const code of kb[action]) if (this.keysPending.has(code)) return true
    }
    return false
  }

  /** Index into the pads array for a gamepad reference (matching by id first). */
  resolvePad(ref: { index: number; id: string | null }): number {
    const direct = this.pads[ref.index]
    if (direct?.connected && (ref.id === null || direct.id === ref.id)) return ref.index
    if (ref.id !== null) {
      const byId = this.pads.findIndex((p) => p.connected && p.id === ref.id)
      if (byId >= 0) return byId
    }
    return direct?.connected ? ref.index : -1
  }

  // ---------------------------------------------------------------- rebinding

  /** Resolve with the next key (Escape cancels with null). */
  captureKey(): Promise<KeyCode | null> {
    this.cancelCapture()
    return new Promise((resolve) => {
      this.capture = { kind: 'keyboard', resolve }
    })
  }

  /** Resolve with the next gamepad button/axis on the given pad (any pad if null). */
  captureGamepad(padIndex: number | null): Promise<GamepadCode | null> {
    this.cancelCapture()
    for (const p of this.pads) p.pending.fill(0)
    return new Promise((resolve) => {
      this.capture = { kind: 'gamepad', padIndex, resolve }
    })
  }

  cancelCapture(): void {
    const cap = this.capture
    this.capture = null
    cap?.resolve(null)
  }

  get capturing(): boolean {
    return this.capture !== null
  }

  // ---------------------------------------------------------------- internals

  private isKeyboardOwner(slot: PlayerSlot): boolean {
    // the first player using the keyboard also gets Enter/Esc/arrows in menus
    const players = this.controls.players
    if (slot === 1 && players[0].device.kind === 'keyboard') return false
    return players[slot].device.kind === 'keyboard'
  }

  private keyboardMenuFor(pc: PlayerControls): number {
    const kb = pc.keyboard
    let m = 0
    const any = (codes: readonly KeyCode[]): boolean => {
      for (const c of codes) if (this.keysPending.has(c)) return true
      return false
    }
    if (any(kb.jump)) m |= MENU_BIT.up
    if (any(kb.down)) m |= MENU_BIT.down
    if (any(kb.left)) m |= MENU_BIT.left
    if (any(kb.right)) m |= MENU_BIT.right
    if (any(kb.light)) m |= MENU_BIT.confirm
    if (any(kb.kick)) m |= MENU_BIT.back
    return m
  }

  private globalKeyboardMenu(withArrows = true): number {
    let m = 0
    for (const c of MENU_KEYS_CONFIRM) if (this.keysPending.has(c)) m |= MENU_BIT.confirm
    for (const c of MENU_KEYS_BACK) if (this.keysPending.has(c)) m |= MENU_BIT.back
    if (withArrows) for (const [c, bit] of MENU_KEYS_NAV) if (this.keysPending.has(c)) m |= bit
    return m
  }

  private padMenu(st: PadState): number {
    let m = 0
    if (st.pending[PAD.UP] || st.menuPending[0]) m |= MENU_BIT.up
    if (st.pending[PAD.DOWN] || st.menuPending[1]) m |= MENU_BIT.down
    if (st.pending[PAD.LEFT] || st.menuPending[2]) m |= MENU_BIT.left
    if (st.pending[PAD.RIGHT] || st.menuPending[3]) m |= MENU_BIT.right
    if (st.pending[PAD.A] || st.pending[PAD.START]) m |= MENU_BIT.confirm
    if (st.pending[PAD.B] || st.pending[PAD.BACK]) m |= MENU_BIT.back
    return m
  }

  private setPad(st: PadState, code: number, down: boolean): void {
    if (st.fresh && down) st.masked[code] = 1
    if (st.masked[code]) {
      if (!down) st.masked[code] = 0
      down = false
    }
    if (down && !st.held[code]) {
      st.pending[code] = 1
      if (code < AXIS_BASE) this.lastStyle = isPlayStationPad(st.id) ? 'playstation' : 'xbox'
    }
    st.held[code] = down ? 1 : 0
  }

  private setMenuAxis(st: PadState, dir: number, down: boolean): void {
    if (down && !st.menuHeld[dir]) st.menuPending[dir] = 1
    st.menuHeld[dir] = down ? 1 : 0
  }

  private isBoundKey(code: KeyCode): boolean {
    for (const pc of this.controls.players) {
      for (const action of INPUT_ACTIONS) if (pc.keyboard[action].includes(code)) return true
    }
    return false
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return
    if (this.capture?.kind === 'keyboard') {
      e.preventDefault()
      const cap = this.capture
      this.capture = null
      cap.resolve(e.code === 'Escape' ? null : e.code)
      return
    }
    if (this.capture) {
      // waiting for a gamepad button: Escape cancels
      if (e.code === 'Escape') {
        e.preventDefault()
        this.cancelCapture()
      }
      return
    }
    if (ALWAYS_PREVENT.has(e.code) || this.isBoundKey(e.code)) e.preventDefault()
    if (e.repeat) return
    this.keysHeld.add(e.code)
    this.keysPending.add(e.code)
    this.lastStyle = 'keyboard'
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keysHeld.delete(e.code)
  }

  private readonly onBlur = (): void => {
    this.keysHeld.clear()
    this.touchHeld = 0
  }

  private readonly onPadEvent = (): void => {
    this.poll()
  }
}

/** Sony vendor id or the names browsers report for DualShock / DualSense. */
function isPlayStationPad(id: string): boolean {
  return /054c|dualshock|dualsense|wireless controller|playstation/i.test(id)
}

/** App-wide singleton: devices are global, screens come and go. */
export const inputManager = new InputManager()
