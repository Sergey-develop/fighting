import type { Fighter, FighterState } from '../combat/fighter'
import { isAttackState } from '../combat/fighter'
import type { AttackDefinition, AttackKind, ComboDefinition } from '../fighters/types'
import { ACTION_BIT, type InputAction, type InputFrame } from '../input/actions'
import type { InputSource } from '../input/sources'

/**
 * What the AI can "see" of its opponent — the same information a human
 * reads from the screen and HUD. Captured every tick into a ring buffer and
 * consumed with a reaction delay, so the AI never reacts instantly.
 */
interface Observation {
  x: number
  y: number
  airborne: boolean
  state: FighterState
  attackKind: AttackKind | null
  /** the visible attack is still winding up */
  attackStarting: boolean
  hpRatio: number
  energy: number
}

function blankObservation(): Observation {
  return { x: 0, y: 0, airborne: false, state: 'IDLE', attackKind: null, attackStarting: false, hpRatio: 1, energy: 0 }
}

export interface AiTuning {
  /** reaction delay range in ticks */
  reactionMin: number
  reactionMax: number
  /** ticks between decisions */
  thinkMin: number
  thinkMax: number
  blockChance: number
  antiAirChance: number
  comboChance: number
  specialChance: number
  jumpInChance: number
}

export const DEFAULT_AI_TUNING: AiTuning = {
  reactionMin: 11,
  reactionMax: 20,
  thinkMin: 6,
  thinkMax: 14,
  blockChance: 0.6,
  antiAirChance: 0.45,
  comboChance: 0.5,
  specialChance: 0.3,
  jumpInChance: 0.15,
}

const HISTORY = 32

type Plan = 'neutral' | 'approach' | 'retreat' | 'block' | 'combo'

/** Reach of an attack's hitbox from the fighter's anchor. */
function reach(atk: AttackDefinition): number {
  return atk.hitbox.x + atk.hitbox.width / 2
}

/**
 * A single, fair AI opponent. It outputs InputFrames exactly like a device;
 * damage, cancels and combos are all resolved by the shared combat system.
 */
export class AiController implements InputSource {
  readonly kind = 'ai'

  private readonly seen: Observation[] = Array.from({ length: HISTORY }, blankObservation)
  private seenHead = 0
  private seenCount = 0
  private tick = 0

  private plan: Plan = 'neutral'
  private planUntil = 0
  private nextThink = 0
  private reaction = 14
  private held = 0
  private pressQueue = 0

  private combo: ComboDefinition | null = null
  private comboStep = 0
  /** history count when the current combo step was pressed */
  private comboPressedAt = 0

  constructor(
    private readonly me: Fighter,
    private readonly opp: Fighter,
    private readonly tuning: AiTuning = DEFAULT_AI_TUNING,
    private readonly random: () => number = Math.random,
  ) {}

  /** Call once per simulation tick before readTick (records what is on screen). */
  observe(): void {
    const o = this.seen[this.seenHead]
    if (!o) return
    const opp = this.opp
    o.x = opp.x
    o.y = opp.y
    o.airborne = opp.airborne
    o.state = opp.state
    o.attackKind = opp.attack ? opp.attack.kind : null
    o.attackStarting = opp.attack !== null && opp.attackPhase === 'startup'
    o.hpRatio = opp.hp / opp.def.stats.maxHp
    o.energy = opp.energy
    this.seenHead = (this.seenHead + 1) % HISTORY
    if (this.seenCount < HISTORY) this.seenCount++
  }

  /** Observation from `delay` ticks ago (or the oldest available). */
  private delayed(delay: number): Observation | null {
    if (this.seenCount === 0) return null
    const d = Math.min(delay, this.seenCount - 1)
    return this.seen[(this.seenHead - 1 - d + HISTORY * 2) % HISTORY] ?? null
  }

  readTick(out: InputFrame): void {
    this.tick++
    this.pressQueue = 0
    const view = this.delayed(this.reaction)
    if (!view || this.me.state === 'INTRO' || this.me.state === 'KO' || this.me.state === 'WIN') {
      this.held = 0
    } else {
      this.continueCombo()
      if (this.tick >= this.nextThink) this.think(view)
      this.applyPlan(view)
    }
    out.held = this.held
    out.pressed = this.pressQueue
  }

  // ------------------------------------------------------------- decisions

  private rand(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1))
  }

  private press(action: InputAction): void {
    this.pressQueue |= ACTION_BIT[action]
  }

  private think(view: Observation): void {
    const t = this.tuning
    this.nextThink = this.tick + this.rand(t.thinkMin, t.thinkMax)
    this.reaction = this.rand(t.reactionMin, t.reactionMax)

    const me = this.me
    if (this.combo) return
    const busy = isAttackState(me.state) || me.state === 'HIT' || me.state === 'BLOCK_STUN' || me.airborne
    if (busy && !me.airborne) return

    const dist = Math.abs(view.x - me.x)
    const myHp = me.hp / me.def.stats.maxHp
    const desperate = myHp < 0.3 && view.hpRatio > myHp + 0.2
    const atk = me.def.attacks

    // air: one attack when close enough
    if (me.airborne) {
      if (me.airAttacksUsed === 0 && dist < reach(atk.airKick) + 40 && this.random() < 0.7) {
        this.press(this.random() < 0.5 ? 'kick' : 'light')
      }
      return
    }

    // react to what the opponent is visibly doing
    const threatened = view.attackKind !== null && view.attackStarting && dist < 520
    if (threatened && this.random() < t.blockChance + (desperate ? 0.2 : 0)) {
      this.setPlan('block', this.rand(18, 32))
      return
    }
    if (view.airborne && dist < 330 && view.state !== 'HIT' && view.state !== 'KO') {
      if (this.random() < t.antiAirChance) {
        this.press(this.random() < 0.6 ? 'kick' : 'light')
        return
      }
      this.setPlan('block', this.rand(14, 24))
      return
    }

    // punish an opponent stuck in recovery right in front of us
    const oppRecovering = view.attackKind !== null && !view.attackStarting && view.state !== 'HIT'
    if (oppRecovering && dist < reach(atk.light) + 30) {
      this.startCombo()
      return
    }

    // special when it fits
    const sp = me.def.special
    if (me.energy >= sp.energyCost && dist > 250 && dist < reach(sp) - 40 && this.random() < t.specialChance) {
      this.press('special')
      this.setPlan('neutral', 10)
      return
    }

    // up close, sometimes guard on a hunch (no visible threat yet) — like a human would
    if (dist < 260 && view.attackKind === null && this.random() < 0.12) {
      this.setPlan('block', this.rand(12, 22))
      return
    }

    if (dist <= reach(atk.light) + 10) {
      const r = this.random()
      if (r < t.comboChance) this.startCombo()
      else if (r < t.comboChance + 0.15) this.press('heavy')
      else if (r < t.comboChance + 0.3) this.press('kick')
      else if (desperate || r < t.comboChance + 0.4) this.setPlan('retreat', this.rand(12, 28))
      else this.setPlan('block', this.rand(10, 20))
      return
    }
    if (dist <= reach(atk.heavy) + 10 && this.random() < 0.35) {
      this.press(this.random() < 0.5 ? 'heavy' : 'kick')
      return
    }
    if (dist > 260 && dist < 520 && this.random() < t.jumpInChance) {
      this.held = this.towards(view) === 1 ? ACTION_BIT.right : ACTION_BIT.left
      this.press('jump')
      return
    }
    if (desperate && this.random() < 0.3) {
      this.setPlan('retreat', this.rand(20, 40))
      return
    }
    this.setPlan('approach', this.rand(10, 30))
  }

  private setPlan(plan: Plan, ticks: number): void {
    this.plan = plan
    this.planUntil = this.tick + ticks
  }

  private towards(view: Observation): 1 | -1 {
    return view.x >= this.me.x ? 1 : -1
  }

  private applyPlan(view: Observation): void {
    if (this.tick > this.planUntil) this.plan = 'neutral'
    const dir = this.towards(view)
    switch (this.plan) {
      case 'approach':
        this.held = dir === 1 ? ACTION_BIT.right : ACTION_BIT.left
        break
      case 'retreat':
        this.held = dir === 1 ? ACTION_BIT.left : ACTION_BIT.right
        break
      case 'block':
        this.held = ACTION_BIT.block
        break
      case 'combo':
      case 'neutral':
        if (!this.me.airborne) this.held = 0
        break
    }
  }

  // ----------------------------------------------------------------- combos

  private startCombo(): void {
    const combos = this.me.def.combos.filter((c) => c.sequence[0] !== 'special')
    const affordable = combos.filter((c) => !c.sequence.includes('special') || this.me.energy >= this.me.def.special.energyCost)
    const pick = affordable[Math.floor(this.random() * affordable.length)]
    if (!pick) {
      this.press('light')
      return
    }
    this.combo = pick
    this.comboStep = 0
    this.plan = 'combo'
    this.planUntil = this.tick + 120
    this.pressComboStep()
  }

  private pressComboStep(): void {
    const kind = this.combo?.sequence[this.comboStep]
    if (!kind) {
      this.combo = null
      return
    }
    this.press(kind)
    this.comboPressedAt = this.tick
    this.comboStep++
  }

  /**
   * Chains the next combo button once the previous attack visibly connected
   * (the AI sees its own hit spark, like a player would). Gives up on a whiff.
   */
  private continueCombo(): void {
    const c = this.combo
    if (!c) return
    const me = this.me
    if (this.tick - this.comboPressedAt < 3) return
    if (!isAttackState(me.state)) {
      this.combo = null
      this.plan = 'neutral'
      return
    }
    if (me.attackConnected && me.hitstop === 0 && me.attackPhase !== 'startup') {
      if (this.comboStep >= c.sequence.length) {
        this.combo = null
        return
      }
      this.pressComboStep()
    }
  }
}
