import type { PlayerSlot } from './types'
import type { ImpactStyle } from '../fighters/types'
import type { SoundId } from '../audio/sounds'

export type GameEventType =
  | 'attack' // an attack started (sound)
  | 'jump'
  | 'land'
  | 'hit'
  | 'block'
  | 'guardBreak'
  | 'ko'
  | 'energyDenied'
  | 'comboFinisher'

/**
 * Pooled event record. Fields not relevant to a type keep stale values —
 * consumers only read what the type defines.
 */
export interface GameEvent {
  type: GameEventType
  /** slot that caused the event (attacker for hits) */
  slot: PlayerSlot
  x: number
  y: number
  damage: number
  impact: ImpactStyle
  sound: SoundId
  /** colour for special VFX */
  color: string
  /** combo / move name */
  text: string
  shake: number
}

function blankEvent(): GameEvent {
  return {
    type: 'attack',
    slot: 0,
    x: 0,
    y: 0,
    damage: 0,
    impact: 'light',
    sound: 'hit-light',
    color: '#ffffff',
    text: '',
    shake: 0,
  }
}

/** Fixed-size event queue reused every tick (no per-frame allocations). */
export class EventQueue {
  private readonly pool: GameEvent[]
  private count = 0

  constructor(capacity = 64) {
    this.pool = Array.from({ length: capacity }, blankEvent)
  }

  /** Returns a recycled event to fill, or null if the queue is full this tick. */
  push(type: GameEventType, slot: PlayerSlot): GameEvent | null {
    const e = this.pool[this.count]
    if (!e) return null
    this.count++
    e.type = type
    e.slot = slot
    e.x = 0
    e.y = 0
    e.damage = 0
    e.text = ''
    e.shake = 0
    return e
  }

  get length(): number {
    return this.count
  }

  at(i: number): GameEvent {
    const e = this.pool[i]
    if (!e || i >= this.count) throw new RangeError(`event ${i} out of range`)
    return e
  }

  clear(): void {
    this.count = 0
  }
}
