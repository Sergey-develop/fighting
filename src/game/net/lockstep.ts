import { TICK_MS } from '../core/config'
import type { PlayerSlot } from '../core/types'
import type { InputFrame } from '../input/actions'
import type { GameMessage, NetMessage } from './connection'

/** Input delay bounds, ticks. */
export const MIN_INPUT_DELAY = 2
export const MAX_INPUT_DELAY = 8

/** Input delay that hides the one-way latency for a measured round trip. */
export function inputDelayForRtt(rttMs: number): number {
  const d = Math.ceil(rttMs / 2 / TICK_MS) + 1
  return Math.min(MAX_INPUT_DELAY, Math.max(MIN_INPUT_DELAY, d))
}

/** How often (ticks) the sides compare state checksums. */
export const CHECKSUM_INTERVAL = 30

export interface LockstepLink {
  send(m: NetMessage): void
  readonly rtt: number
}

function pack(f: InputFrame): number {
  return (f.held & 0xffff) | ((f.pressed & 0xffff) << 16)
}

/**
 * Delay-based lockstep: the simulation is deterministic, so the two browsers
 * only exchange inputs. Local input sampled on tick t is applied on tick
 * t + delay on both sides; a tick runs only once the opponent's input for it
 * has arrived.
 */
export class Lockstep {
  private readonly local = new Map<number, number>()
  private readonly remote = new Map<number, number>()
  private readonly localSums = new Map<number, number>()
  private readonly remoteSums = new Map<number, number>()
  /** highest tick the opponent sent input for */
  private remoteLatest = -1
  desynced = false

  constructor(
    private readonly link: LockstepLink,
    readonly localSlot: PlayerSlot,
    /** match serial: messages from an older match are ignored */
    private readonly matchId: number,
    readonly delay: number,
  ) {}

  receive(m: GameMessage): void {
    if (m.m !== this.matchId) return
    if (m.t === 'in') {
      this.remote.set(m.k, (m.h & 0xffff) | ((m.p & 0xffff) << 16))
      if (m.k > this.remoteLatest) this.remoteLatest = m.k
    } else {
      this.remoteSums.set(m.k, m.s)
      this.compare(m.k)
    }
  }

  /** Can tick `tick` be simulated (opponent's input is here)? */
  ready(tick: number): boolean {
    return tick < this.delay || this.remote.has(tick)
  }

  /**
   * Record local input sampled now (applied at tick + delay), send it, and
   * fill both seats' input for `tick`. Call only when ready(tick).
   */
  advance(tick: number, sampled: InputFrame, out: [InputFrame, InputFrame]): void {
    const at = tick + this.delay
    this.local.set(at, pack(sampled))
    this.link.send({ t: 'in', m: this.matchId, k: at, h: sampled.held, p: sampled.pressed })
    const mine = this.local.get(tick) ?? 0
    const theirs = this.remote.get(tick) ?? 0
    this.local.delete(tick)
    this.remote.delete(tick)
    const a = out[this.localSlot]
    const b = out[this.localSlot === 0 ? 1 : 0]
    a.held = mine & 0xffff
    a.pressed = mine >>> 16
    b.held = theirs & 0xffff
    b.pressed = theirs >>> 16
  }

  /**
   * >0 when this side runs ahead of the opponent (in ticks). The caller slows
   * down slightly so both clocks stay together instead of stuttering.
   */
  advantage(tick: number): number {
    if (this.remoteLatest < 0) return 0
    const oneWay = this.link.rtt / 2 / TICK_MS
    const remoteTick = this.remoteLatest - this.delay + oneWay
    return tick - remoteTick
  }

  checksum(tick: number, sum: number): void {
    this.localSums.set(tick, sum)
    this.link.send({ t: 'sum', m: this.matchId, k: tick, s: sum })
    this.compare(tick)
  }

  private compare(tick: number): void {
    const a = this.localSums.get(tick)
    const b = this.remoteSums.get(tick)
    if (a === undefined || b === undefined) return
    this.localSums.delete(tick)
    this.remoteSums.delete(tick)
    if (a !== b && !this.desynced) {
      this.desynced = true
      console.error(`[online] desync detected at tick ${tick}`)
    }
  }
}
