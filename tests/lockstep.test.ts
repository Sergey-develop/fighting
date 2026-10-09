import { describe, expect, it } from 'vitest'
import { AiController } from '../src/game/ai/ai-controller'
import { CombatSystem } from '../src/game/combat/combat-system'
import { Fighter } from '../src/game/combat/fighter'
import { EventQueue } from '../src/game/core/events'
import type { PlayerSlot } from '../src/game/core/types'
import { createInputFrame, type InputFrame } from '../src/game/input/actions'
import developer from '../src/game/fighters/defs/developer'
import producer from '../src/game/fighters/defs/producer'
import type { GameMessage, NetMessage } from '../src/game/net/connection'
import { Lockstep, inputDelayForRtt } from '../src/game/net/lockstep'
import { Match } from '../src/game/rounds/match'

function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One browser: its own copy of the simulation, an AI playing its seat. */
class Side {
  readonly fighters: [Fighter, Fighter] = [new Fighter(developer, 0), new Fighter(producer, 1)]
  readonly events = new EventQueue()
  readonly combat = new CombatSystem(this.fighters, this.events)
  readonly match = new Match(this.fighters, this.combat, { roundTimeSeconds: 30, roundsToWin: 2 })
  readonly inputs: [InputFrame, InputFrame] = [createInputFrame(), createInputFrame()]
  readonly sampled = createInputFrame()
  readonly ai: AiController
  readonly lockstep: Lockstep
  readonly outbox: { at: number; m: GameMessage }[] = []
  readonly trace: string[] = []
  tick = 0

  constructor(slot: PlayerSlot, delay: number, seed: number, latency: () => number, now: () => number) {
    const me = this.fighters[slot]
    const other = this.fighters[slot === 0 ? 1 : 0]
    this.ai = new AiController(me, other, undefined, rng(seed))
    const link = {
      rtt: 0,
      send: (m: NetMessage) => {
        // in-order delivery (reliable data channel) with jittery latency
        const prev = this.outbox[this.outbox.length - 1]?.at ?? 0
        this.outbox.push({ at: Math.max(prev, now() + latency()), m: m as GameMessage })
      },
    }
    this.lockstep = new Lockstep(link, slot, 1, delay)
    this.match.startMatch()
  }

  /** One rendered frame: runs the tick if the opponent's input is here. */
  frame(): void {
    if (this.match.isOver || !this.lockstep.ready(this.tick)) return
    this.ai.observe()
    this.ai.readTick(this.sampled)
    this.lockstep.advance(this.tick, this.sampled, this.inputs)
    this.events.clear()
    this.combat.step(this.inputs, this.tick)
    this.match.step()
    const [a, b] = this.fighters
    this.trace.push(`${a.x.toFixed(3)},${a.y.toFixed(3)},${a.hp},${a.state}|${b.x.toFixed(3)},${b.y.toFixed(3)},${b.hp},${b.state}`)
    this.tick++
  }
}

describe('online lockstep', () => {
  it('picks a bigger input delay for a slower connection', () => {
    expect(inputDelayForRtt(10)).toBe(2)
    expect(inputDelayForRtt(100)).toBeGreaterThan(inputDelayForRtt(30))
    expect(inputDelayForRtt(5000)).toBe(8)
  })

  it('keeps both simulations identical despite jittery latency', () => {
    for (const seed of [1, 2, 3]) {
      let now = 0
      const r = rng(seed * 101)
      const latency = (): number => 1 + Math.floor(r() * 8) // 1..8 frames
      const delay = 3
      const sides = [new Side(0, delay, seed, latency, () => now), new Side(1, delay, seed + 50, latency, () => now)] as const
      const deliver = (from: Side, to: Side): void => {
        while (from.outbox.length && (from.outbox[0]?.at ?? Infinity) <= now) to.lockstep.receive(from.outbox.shift()!.m)
      }
      for (; now < 60 * 60 * 6 && !(sides[0].match.isOver && sides[1].match.isOver); now++) {
        deliver(sides[0], sides[1])
        deliver(sides[1], sides[0])
        // the two browsers don't run frames in lock-step with each other
        sides[0].frame()
        if (r() < 0.97) sides[1].frame()
      }
      expect(sides[0].match.isOver).toBe(true)
      expect(sides[1].match.isOver).toBe(true)
      expect(sides[0].tick).toBe(sides[1].tick)
      expect(sides[0].trace).toEqual(sides[1].trace)
      expect(sides[0].match.matchWinner).toBe(sides[1].match.matchWinner)
    }
  })
})
