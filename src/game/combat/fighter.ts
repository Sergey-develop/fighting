import { COMBAT_CONFIG } from '../core/config'
import { createRect, type Facing, type PlayerSlot, type Rect } from '../core/types'
import type {
  AttackDefinition,
  AttackKind,
  AttackSlot,
  BoxDefinition,
  ComboDefinition,
  FighterDefinition,
} from '../fighters/types'

/**
 * Fighter state machine states. Exactly one is active at a time; all
 * "is attacking / is blocking / is airborne" questions derive from it.
 */
export type FighterState =
  | 'INTRO'
  | 'IDLE'
  | 'WALK'
  | 'JUMP_SQUAT'
  | 'JUMP'
  | 'FALL'
  | 'LAND'
  | 'LIGHT_ATTACK'
  | 'HEAVY_ATTACK'
  | 'KICK'
  | 'SPECIAL'
  | 'BLOCK'
  | 'BLOCK_STUN'
  | 'HIT'
  | 'KO'
  | 'WIN'

export const ATTACK_STATE: Readonly<Record<AttackKind, FighterState>> = {
  light: 'LIGHT_ATTACK',
  heavy: 'HEAVY_ATTACK',
  kick: 'KICK',
  special: 'SPECIAL',
}

export function isAttackState(s: FighterState): boolean {
  return s === 'LIGHT_ATTACK' || s === 'HEAVY_ATTACK' || s === 'KICK' || s === 'SPECIAL'
}

/** States in which the fighter accepts new commands on the ground. */
export function isGroundActionable(s: FighterState): boolean {
  return s === 'IDLE' || s === 'WALK' || s === 'BLOCK'
}

export type AttackPhase = 'startup' | 'active' | 'recovery' | 'done'

export function attackPhase(atk: AttackDefinition, frame: number): AttackPhase {
  if (frame < atk.startupFrames) return 'startup'
  if (frame < atk.startupFrames + atk.activeFrames) return 'active'
  if (frame < atk.startupFrames + atk.activeFrames + atk.recoveryFrames) return 'recovery'
  return 'done'
}

/** One entry of the per-fighter attack history used for combo recognition. */
export interface AttackRecord {
  kind: AttackKind
  tick: number
  connected: boolean
}

const HISTORY_SIZE = 6

export class Fighter {
  readonly slot: PlayerSlot
  readonly def: FighterDefinition

  x = 0
  /** height above the floor */
  y = 0
  vx = 0
  vy = 0
  prevX = 0
  prevY = 0
  facing: Facing = 1
  airborne = false

  state: FighterState = 'IDLE'
  /** ticks spent in the current state */
  stateFrame = 0

  hp: number
  energy: number

  attack: AttackDefinition | null = null
  attackSlot: AttackSlot | null = null
  /** current attack touched the opponent (hit or blocked) */
  attackConnected = false
  /** current attack already applied its hit this activation */
  attackHitDone = false
  /** combo this attack finishes, if any */
  attackCombo: ComboDefinition | null = null
  /** number of attacks linked through cancels */
  chainLength = 0
  airAttacksUsed = 0

  /** remaining hitstun / blockstun ticks */
  stunFrames = 0
  /** remaining freeze ticks after contact */
  hitstop = 0
  /** cannot be hit again until landing (no juggles / air combos) */
  juggleProtected = false
  /** white flash ticks after being hit */
  flashFrames = 0
  /** direction the fighter moves in WALK (+1 right, -1 left) */
  walkDir: -1 | 0 | 1 = 0

  /** buffered inputs (tick when pressed, -1 = none) */
  bufferedAttack: AttackKind | null = null
  bufferedAttackTick = -1
  bufferedJumpTick = -1

  /** as attacker: current combo counter */
  comboHits = 0
  /** the opponent is still stunned by this combo */
  comboActive = false
  comboDamage = 0
  /** ticks the finished combo stays on the HUD */
  comboDisplay = 0
  lastComboName = ''

  readonly history: AttackRecord[] = Array.from({ length: HISTORY_SIZE }, () => ({
    kind: 'light' as AttackKind,
    tick: -1000,
    connected: false,
  }))
  historyCount = 0

  /** scratch rects reused for collision queries */
  readonly hurtRects: Rect[]
  readonly hitRect: Rect = createRect()

  constructor(def: FighterDefinition, slot: PlayerSlot) {
    this.def = def
    this.slot = slot
    this.hp = def.stats.maxHp
    this.energy = COMBAT_CONFIG.energy.startValue
    const maxBoxes = Math.max(def.hurtboxes.standing.length, def.hurtboxes.airborne.length, def.hurtboxes.down.length)
    this.hurtRects = Array.from({ length: maxBoxes }, createRect)
  }

  /** Reset for a new round (keeps definition and slot). */
  resetForRound(x: number, facing: Facing): void {
    this.x = this.prevX = x
    this.y = this.prevY = 0
    this.vx = this.vy = 0
    this.facing = facing
    this.airborne = false
    this.hp = this.def.stats.maxHp
    this.energy = COMBAT_CONFIG.energy.startValue
    this.attack = null
    this.attackSlot = null
    this.attackConnected = false
    this.attackHitDone = false
    this.attackCombo = null
    this.chainLength = 0
    this.airAttacksUsed = 0
    this.stunFrames = 0
    this.hitstop = 0
    this.juggleProtected = false
    this.flashFrames = 0
    this.walkDir = 0
    this.bufferedAttack = null
    this.bufferedAttackTick = -1
    this.bufferedJumpTick = -1
    this.comboHits = 0
    this.comboActive = false
    this.comboDamage = 0
    this.comboDisplay = 0
    this.lastComboName = ''
    this.clearHistory()
    this.setState('INTRO')
  }

  setState(state: FighterState): void {
    this.state = state
    this.stateFrame = 0
    if (!isAttackState(state)) {
      this.attack = null
      this.attackSlot = null
      this.attackCombo = null
    }
  }

  get attackPhase(): AttackPhase {
    return this.attack ? attackPhase(this.attack, this.stateFrame) : 'done'
  }

  get isKO(): boolean {
    return this.state === 'KO'
  }

  pushHistory(kind: AttackKind, tick: number): void {
    // shift (fixed size, no allocation)
    if (this.historyCount === HISTORY_SIZE) {
      const first = this.history[0]
      if (!first) return
      for (let i = 1; i < HISTORY_SIZE; i++) {
        const cur = this.history[i]
        if (cur) this.history[i - 1] = cur
      }
      this.history[HISTORY_SIZE - 1] = first
      this.historyCount--
    }
    const rec = this.history[this.historyCount]
    if (!rec) return
    rec.kind = kind
    rec.tick = tick
    rec.connected = false
    this.historyCount++
  }

  lastHistory(): AttackRecord | null {
    return this.historyCount > 0 ? (this.history[this.historyCount - 1] ?? null) : null
  }

  /** k-th most recent record (0 = latest). */
  historyBack(k: number): AttackRecord | null {
    const i = this.historyCount - 1 - k
    return i >= 0 ? (this.history[i] ?? null) : null
  }

  clearHistory(): void {
    this.historyCount = 0
  }

  /** Fill hurtRects for the current pose; returns the number of valid rects. */
  computeHurtboxes(): number {
    const boxes: readonly BoxDefinition[] =
      this.state === 'KO' && !this.airborne
        ? this.def.hurtboxes.down
        : this.airborne
          ? this.def.hurtboxes.airborne
          : this.def.hurtboxes.standing
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      const r = this.hurtRects[i]
      if (b && r) this.boxToRect(b, r)
    }
    return boxes.length
  }

  /** World rect of a box definition relative to this fighter. */
  boxToRect(b: BoxDefinition, out: Rect, offsetX = 0): Rect {
    const cx = this.x + this.facing * (b.x + offsetX)
    out.left = cx - b.width / 2
    out.right = cx + b.width / 2
    out.bottom = this.y + b.y
    out.top = this.y + b.y + b.height
    return out
  }
}
