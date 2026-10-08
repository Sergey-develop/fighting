import { COMBAT_CONFIG, TICK_RATE } from '../core/config'
import { type PlayerSlot } from '../core/types'
import type { CombatSystem } from '../combat/combat-system'
import type { Fighter } from '../combat/fighter'

export type MatchPhase = 'READY' | 'FIGHT_TEXT' | 'FIGHTING' | 'KO' | 'TIME_OVER' | 'ROUND_END' | 'MATCH_END'

/** Outcome of a round: a slot, or 'draw' (double KO / equal HP at time over). */
export type RoundResult = PlayerSlot | 'draw'

export interface MatchOptions {
  roundTimeSeconds: number
  roundsToWin: number
}

const R = COMBAT_CONFIG.rounds

/**
 * Best-of-N round flow. Drives CombatSystem.controlEnabled and fighter
 * intro/win states; never touches damage or input.
 */
export class Match {
  phase: MatchPhase = 'READY'
  phaseFrame = 0
  round = 1
  readonly wins: [number, number] = [0, 0]
  timerTicks = 0
  roundResult: RoundResult | null = null
  matchWinner: PlayerSlot | null = null
  /** monotonically increasing; lets the HUD notice phase changes cheaply */
  phaseSerial = 0

  constructor(
    private readonly fighters: readonly [Fighter, Fighter],
    private readonly combat: CombatSystem,
    readonly options: MatchOptions = { roundTimeSeconds: R.roundTimeSeconds, roundsToWin: R.roundsToWin },
  ) {}

  get timeScale(): number {
    return this.phase === 'KO' ? R.koTimeScale : 1
  }

  get secondsLeft(): number {
    return Math.ceil(this.timerTicks / TICK_RATE)
  }

  get isOver(): boolean {
    return this.phase === 'MATCH_END'
  }

  startMatch(): void {
    this.wins[0] = 0
    this.wins[1] = 0
    this.round = 1
    this.matchWinner = null
    this.startRound()
  }

  private setPhase(p: MatchPhase): void {
    this.phase = p
    this.phaseFrame = 0
    this.phaseSerial++
  }

  private startRound(): void {
    const [a, b] = this.fighters
    const [x0, x1] = COMBAT_CONFIG.arena.spawnX
    a.resetForRound(x0, 1)
    b.resetForRound(x1, -1)
    this.timerTicks = this.options.roundTimeSeconds * TICK_RATE
    this.roundResult = null
    this.combat.controlEnabled = false
    this.setPhase('READY')
  }

  /** One simulation tick of the round flow; call after CombatSystem.step. */
  step(): void {
    this.phaseFrame++
    const [a, b] = this.fighters
    switch (this.phase) {
      case 'READY':
        if (this.phaseFrame >= R.readyFrames) {
          for (const f of this.fighters) if (f.state === 'INTRO') f.setState('IDLE')
          this.combat.controlEnabled = true
          this.setPhase('FIGHT_TEXT')
        }
        break
      case 'FIGHT_TEXT':
        if (this.phaseFrame >= R.fightTextFrames) this.setPhase('FIGHTING')
        this.tickTimer()
        break
      case 'FIGHTING':
        this.tickTimer()
        break
      case 'KO':
      case 'TIME_OVER':
        this.celebrateWhenSettled()
        if (this.phaseFrame >= R.koFreezeFrames) {
          this.setPhase('ROUND_END')
        }
        break
      case 'ROUND_END':
        this.celebrateWhenSettled()
        if (this.phaseFrame >= R.roundEndFrames) {
          const w = this.matchWinnerIfAny()
          if (w !== null) {
            this.matchWinner = w
            this.setPhase('MATCH_END')
          } else {
            this.round++
            this.startRound()
          }
        }
        break
      case 'MATCH_END':
        break
    }
    // KO is checked every fighting tick (also during the FIGHT! banner)
    if (this.phase === 'FIGHTING' || this.phase === 'FIGHT_TEXT') {
      if (a.isKO || b.isKO) {
        this.endRound(a.isKO && b.isKO ? 'draw' : a.isKO ? 1 : 0, 'KO')
      }
    }
  }

  private tickTimer(): void {
    if (this.timerTicks > 0) this.timerTicks--
    if (this.timerTicks === 0) {
      const [a, b] = this.fighters
      const ra = a.hp / a.def.stats.maxHp
      const rb = b.hp / b.def.stats.maxHp
      this.endRound(Math.abs(ra - rb) < 1e-6 ? 'draw' : ra > rb ? 0 : 1, 'TIME_OVER')
    }
  }

  private endRound(result: RoundResult, phase: 'KO' | 'TIME_OVER'): void {
    this.roundResult = result
    if (result !== 'draw') this.wins[result]++
    this.combat.controlEnabled = false
    this.setPhase(phase)
  }

  /** Winner switches to WIN once back on the ground and free. */
  private celebrateWhenSettled(): void {
    const r = this.roundResult
    if (r === null || r === 'draw') return
    const w = this.fighters[r]
    if (w.state === 'IDLE' && !w.airborne) {
      w.vx = 0
      w.setState('WIN')
    }
  }

  private matchWinnerIfAny(): PlayerSlot | null {
    if (this.wins[0] >= this.options.roundsToWin) return 0
    if (this.wins[1] >= this.options.roundsToWin) return 1
    return null
  }
}
