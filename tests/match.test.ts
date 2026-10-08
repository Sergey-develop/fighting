import { describe, expect, it } from 'vitest'
import { AiController } from '../src/game/ai/ai-controller'
import { CombatSystem } from '../src/game/combat/combat-system'
import { Fighter, type FighterState } from '../src/game/combat/fighter'
import { EventQueue, type GameEventType } from '../src/game/core/events'
import { createInputFrame, type InputFrame } from '../src/game/input/actions'
import developer from '../src/game/fighters/defs/developer'
import producer from '../src/game/fighters/defs/producer'
import { Match } from '../src/game/rounds/match'

/** deterministic PRNG (mulberry32) */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function simulate(seed: number, maxTicks = 60 * 60 * 8) {
  const a = new Fighter(developer, 0)
  const b = new Fighter(producer, 1)
  const events = new EventQueue()
  const combat = new CombatSystem([a, b], events)
  const match = new Match([a, b], combat, { roundTimeSeconds: 60, roundsToWin: 2 })
  const ais = [new AiController(a, b, undefined, rng(seed)), new AiController(b, a, undefined, rng(seed * 7 + 1))]
  const inputs: [InputFrame, InputFrame] = [createInputFrame(), createInputFrame()]
  const states = new Set<FighterState>()
  const eventCounts = new Map<GameEventType, number>()
  let combos = 0
  match.startMatch()
  let tick = 0
  for (; tick < maxTicks && !match.isOver; tick++) {
    ais[0]?.observe()
    ais[1]?.observe()
    ais[0]?.readTick(inputs[0])
    ais[1]?.readTick(inputs[1])
    events.clear()
    combat.step(inputs, tick)
    match.step()
    for (const f of [a, b]) states.add(f.state)
    for (let i = 0; i < events.length; i++) {
      const e = events.at(i)
      eventCounts.set(e.type, (eventCounts.get(e.type) ?? 0) + 1)
      if (e.type === 'comboFinisher') combos++
    }
    // invariants
    expect(a.hp).toBeGreaterThanOrEqual(0)
    expect(b.hp).toBeGreaterThanOrEqual(0)
    expect(a.energy).toBeLessThanOrEqual(100)
  }
  return { match, states, eventCounts, combos, tick }
}

describe('AI vs AI full match (headless)', () => {
  it('finishes a best-of-3 with a winner that has 2 round wins', () => {
    for (const seed of [1, 2, 3]) {
      const { match, tick } = simulate(seed)
      expect(match.isOver, `seed ${seed} did not finish in ${tick} ticks`).toBe(true)
      const w = match.matchWinner
      expect(w).not.toBeNull()
      if (w !== null) expect(match.wins[w]).toBe(2)
      expect(match.round).toBeGreaterThanOrEqual(2)
    }
  })

  it('AI moves, jumps, attacks, blocks, combos and uses specials', () => {
    const states = new Set<FighterState>()
    const counts = new Map<GameEventType, number>()
    let combos = 0
    for (const seed of [11, 12, 13, 14]) {
      const r = simulate(seed)
      r.states.forEach((s) => states.add(s))
      r.eventCounts.forEach((v, k) => counts.set(k, (counts.get(k) ?? 0) + v))
      combos += r.combos
    }
    for (const s of ['WALK', 'JUMP', 'LIGHT_ATTACK', 'HEAVY_ATTACK', 'KICK', 'SPECIAL', 'BLOCK', 'HIT', 'KO', 'WIN'] as const) {
      expect(states.has(s), `state ${s} never reached`).toBe(true)
    }
    expect(counts.get('hit') ?? 0).toBeGreaterThan(20)
    expect(counts.get('block') ?? 0).toBeGreaterThan(0)
    expect(combos).toBeGreaterThan(0)
  })
})
