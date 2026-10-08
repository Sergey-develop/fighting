import type { PlayerSlot } from '../core/types'
import type { InputAction } from './actions'

/** KeyboardEvent.code values (layout independent: works with RU/EN layouts). */
export type KeyCode = string

/**
 * Gamepad input code: 0..31 = standard-mapping button index,
 * AXIS_BASE + axis * 2 (+1 for positive direction) = analog stick direction.
 */
export type GamepadCode = number
export const AXIS_BASE = 100

export function axisCode(axis: number, positive: boolean): GamepadCode {
  return AXIS_BASE + axis * 2 + (positive ? 1 : 0)
}

export type KeyboardBindings = Record<InputAction, KeyCode[]>
export type GamepadBindings = Record<InputAction, GamepadCode[]>

export type DeviceRef =
  | { kind: 'keyboard' }
  | { kind: 'gamepad'; index: number; id: string | null }
  | { kind: 'none' }

export interface PlayerControls {
  device: DeviceRef
  keyboard: KeyboardBindings
  gamepad: GamepadBindings
}

export interface ControlsConfig {
  players: [PlayerControls, PlayerControls]
  /** analog stick dead zone, 0..1 */
  deadzone: number
}

/** Standard gamepad (Xbox layout) button indices. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const

const DEFAULT_GAMEPAD: GamepadBindings = {
  left: [PAD.LEFT, axisCode(0, false)],
  right: [PAD.RIGHT, axisCode(0, true)],
  down: [PAD.DOWN, axisCode(1, true)],
  jump: [PAD.A, PAD.UP],
  light: [PAD.X],
  heavy: [PAD.Y],
  kick: [PAD.B],
  special: [PAD.RB],
  block: [PAD.LB],
  pause: [PAD.START],
}

const DEFAULT_KEYBOARD: readonly [KeyboardBindings, KeyboardBindings] = [
  {
    left: ['KeyA'],
    right: ['KeyD'],
    down: ['KeyS'],
    jump: ['KeyW'],
    light: ['KeyJ'],
    heavy: ['KeyK'],
    kick: ['KeyL'],
    special: ['KeyU'],
    block: ['KeyI'],
    pause: ['Escape'],
  },
  {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    down: ['ArrowDown'],
    jump: ['ArrowUp'],
    light: ['Numpad1', 'Comma'],
    heavy: ['Numpad2', 'Period'],
    kick: ['Numpad3', 'Slash'],
    special: ['Numpad5', 'Quote'],
    block: ['Numpad0', 'ShiftRight'],
    pause: ['Backspace'],
  },
]

function cloneBindings<T extends KeyCode | GamepadCode>(b: Record<InputAction, T[]>): Record<InputAction, T[]> {
  const out = {} as Record<InputAction, T[]>
  for (const k of Object.keys(b) as InputAction[]) out[k] = [...b[k]]
  return out
}

export function defaultPlayerControls(slot: PlayerSlot): PlayerControls {
  return {
    device: slot === 0 ? { kind: 'keyboard' } : { kind: 'gamepad', index: 0, id: null },
    keyboard: cloneBindings(DEFAULT_KEYBOARD[slot]),
    gamepad: cloneBindings(DEFAULT_GAMEPAD),
  }
}

export function defaultKeyboardBindings(slot: PlayerSlot): KeyboardBindings {
  return cloneBindings(DEFAULT_KEYBOARD[slot])
}

export function defaultGamepadBindings(): GamepadBindings {
  return cloneBindings(DEFAULT_GAMEPAD)
}

export function defaultControls(): ControlsConfig {
  return { players: [defaultPlayerControls(0), defaultPlayerControls(1)], deadzone: 0.35 }
}

const PAD_LABELS: Readonly<Record<number, string>> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Back',
  9: 'Start',
  10: 'LS',
  11: 'RS',
  12: 'D↑',
  13: 'D↓',
  14: 'D←',
  15: 'D→',
}

export function gamepadCodeLabel(code: GamepadCode): string {
  if (code >= AXIS_BASE) {
    const axis = Math.floor((code - AXIS_BASE) / 2)
    const positive = (code - AXIS_BASE) % 2 === 1
    const stick = axis < 2 ? 'LS' : 'RS'
    const horizontal = axis % 2 === 0
    const arrow = horizontal ? (positive ? '→' : '←') : positive ? '↓' : '↑'
    return `${stick}${arrow}`
  }
  return PAD_LABELS[code] ?? `Btn${code}`
}

export function keyCodeLabel(code: KeyCode): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`
  const map: Readonly<Record<string, string>> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    ShiftLeft: 'LShift',
    ShiftRight: 'RShift',
    ControlLeft: 'LCtrl',
    ControlRight: 'RCtrl',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    Escape: 'Esc',
    Backspace: '⌫',
    Enter: 'Enter',
  }
  return map[code] ?? code
}
