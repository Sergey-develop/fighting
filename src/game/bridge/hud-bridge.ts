import type { PlayerSlot } from '../core/types'
import type { MatchPhase, RoundResult } from '../rounds/match'

export type PortraitMood = 'normal' | 'hurt' | 'ko'

export interface HudFighter {
  name: string
  hp: number
  maxHp: number
  energy: number
  energyMax: number
  specialCost: number
  wins: number
  comboHits: number
  comboDamage: number
  comboName: string
  mood: PortraitMood
  /** increments when a special was attempted without enough energy */
  energyDeniedSerial: number
  /** increments on every combo finisher */
  comboFinisherSerial: number
  /** increments on guard break */
  guardBreakSerial: number
}

export interface HudSnapshot {
  fighters: [HudFighter, HudFighter]
  timer: number
  round: number
  roundsToWin: number
  phase: MatchPhase
  phaseSerial: number
  roundResult: RoundResult | null
  matchWinner: PlayerSlot | null
  paused: boolean
  /** a player's controller is missing — the game is paused until it is back */
  disconnected: [boolean, boolean]
}

function blankFighter(): HudFighter {
  return {
    name: '',
    hp: 1,
    maxHp: 1,
    energy: 0,
    energyMax: 100,
    specialCost: 50,
    wins: 0,
    comboHits: 0,
    comboDamage: 0,
    comboName: '',
    mood: 'normal',
    energyDeniedSerial: 0,
    comboFinisherSerial: 0,
    guardBreakSerial: 0,
  }
}

/**
 * Controlled bridge between the 60 Hz simulation and Vue. The snapshot is a
 * plain (non-reactive) object mutated in place; subscribers are called once
 * per rendered frame and update the DOM themselves.
 */
export class HudBridge {
  readonly snapshot: HudSnapshot = {
    fighters: [blankFighter(), blankFighter()],
    timer: 0,
    round: 1,
    roundsToWin: 2,
    phase: 'READY',
    phaseSerial: 0,
    roundResult: null,
    matchWinner: null,
    paused: false,
    disconnected: [false, false],
  }
  private readonly listeners = new Set<(s: HudSnapshot) => void>()

  subscribe(cb: (s: HudSnapshot) => void): () => void {
    this.listeners.add(cb)
    cb(this.snapshot)
    return () => this.listeners.delete(cb)
  }

  publish(): void {
    for (const cb of this.listeners) cb(this.snapshot)
  }
}
