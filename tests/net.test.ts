import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Handshake, type HandshakeMessage } from '../src/game/net/handshake'
import { MAX_EARLY, ReliableChannel, isEnvelope, type Envelope } from '../src/game/net/reliable'
import { MatchGate, setupMismatch, type MatchSetup } from '../src/game/net/match-gate'
import { Lockstep } from '../src/game/net/lockstep'
import type { NetMessage } from '../src/game/net/connection'
import { createInputFrame, type InputFrame } from '../src/game/input/actions'

beforeAll(() => {
  // [NET-DIAG] lines are for players' consoles, not for test output
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

// ------------------------------------------------------------ handshake

function pair(): { host: Handshake; guest: Handshake; toGuest: HandshakeMessage[]; toHost: HandshakeMessage[] } {
  const toGuest: HandshakeMessage[] = []
  const toHost: HandshakeMessage[] = []
  return {
    host: new Handshake('host', 3, (m) => toGuest.push(m)),
    guest: new Handshake('guest', 3, (m) => toHost.push(m)),
    toGuest,
    toHost,
  }
}

describe('link handshake', () => {
  it('connects both sides exactly once after hello → hello → ready', () => {
    const { host, guest, toGuest, toHost } = pair()
    host.begin()
    guest.begin()
    expect(toGuest).toEqual([{ t: 'hello', v: 3 }])
    expect(toHost).toEqual([]) // the guest never speaks first
    expect(guest.handle(toGuest.shift()!)).toBe('answered')
    expect(guest.state).toBe('linking') // host→guest works, guest→host not proven yet
    expect(host.handle(toHost.shift()!)).toBe('connected')
    expect(guest.handle(toGuest.shift()!)).toBe('connected')
    expect(host.state).toBe('connected')
    expect(guest.state).toBe('connected')
  })

  it('stays linking when the reply never arrives (failed handshake)', () => {
    const { host, guest, toGuest, toHost } = pair()
    host.begin()
    guest.handle(toGuest.shift()!)
    toHost.length = 0 // guest's hello is lost
    expect(host.state).toBe('linking')
    expect(guest.state).toBe('linking')
  })

  it('duplicates never repeat a transition, but lost replies are answered again', () => {
    const { host, guest, toGuest, toHost } = pair()
    host.begin()
    const hello = toGuest.shift()!
    guest.handle(hello)
    const guestHello = toHost.shift()!
    expect(host.handle(guestHello)).toBe('connected')
    const ready = toGuest.shift()!
    // the same hello delivered again: the host re-confirms, no second 'connected'
    expect(host.handle(guestHello)).toBe('duplicate')
    expect(toGuest).toEqual([{ t: 'ready' }])
    expect(guest.handle(ready)).toBe('connected')
    expect(guest.handle(toGuest.shift()!)).toBe('duplicate')
    // a repeated host hello is answered again (our answer may have been lost)
    expect(guest.handle(hello)).toBe('duplicate')
    expect(toHost).toEqual([{ t: 'hello', v: 3 }])
    expect(host.state).toBe('connected')
    expect(guest.state).toBe('connected')
  })

  it('fails on a protocol version mismatch', () => {
    const guest = new Handshake('guest', 3, () => {})
    expect(guest.handle({ t: 'hello', v: 2 })).toBe('version-mismatch')
    expect(guest.state).toBe('failed')
    expect(guest.handle({ t: 'ready' })).toBe('unexpected')
    expect(guest.state).toBe('failed')
  })

  it('ignores a ready that arrives before the guest said hello', () => {
    const guest = new Handshake('guest', 3, () => {})
    expect(guest.handle({ t: 'ready' })).toBe('unexpected')
    expect(guest.state).toBe('linking')
  })
})

// --------------------------------------------------- reliable relay delivery

function link(): { a: ReliableChannel; b: ReliableChannel } {
  // host side bound to the guest id; guest binds to the first sender
  return { a: new ReliableChannel('host', 'guest'), b: new ReliableChannel('guest', null) }
}

const parse = (p: string): Envelope => JSON.parse(p) as Envelope

describe('reliable relay channel', () => {
  it('a lost message is resent and order is kept', () => {
    const { a, b } = link()
    const p0 = a.wrap('m0', 0)
    const p1 = a.wrap('m1', 0)
    const p2 = a.wrap('m2', 0)
    void p0 // lost on the way
    expect(b.accept(parse(p1))).toEqual({ kind: 'buffered' })
    expect(b.accept(parse(p2))).toEqual({ kind: 'buffered' })
    // nothing acknowledged yet: the sender resends once the timeout passed
    expect(a.due(1000, 1500)).toEqual([])
    const resent = a.due(2000, 1500)
    expect(resent).toHaveLength(3)
    expect(b.accept(parse(resent[0]!))).toEqual({ kind: 'delivered', messages: ['m0', 'm1', 'm2'] })
    // the receiver's ack clears the sender's queue
    expect(a.accept(parse(b.ack()))).toEqual({ kind: 'ack' })
    expect(a.unackedCount).toBe(0)
  })

  it('a message delivered twice is passed on once', () => {
    const { a, b } = link()
    const p = a.wrap({ t: 'start', m: 1 }, 0)
    expect(b.accept(parse(p))).toEqual({ kind: 'delivered', messages: [{ t: 'start', m: 1 }] })
    expect(b.accept(parse(p))).toEqual({ kind: 'duplicate' })
    // a duplicate of a still-buffered message is not stored twice
    const q1 = a.wrap('x', 0)
    const q2 = a.wrap('y', 0)
    expect(b.accept(parse(q2))).toEqual({ kind: 'buffered' })
    expect(b.accept(parse(q2))).toEqual({ kind: 'duplicate' })
    expect(b.accept(parse(q1))).toEqual({ kind: 'delivered', messages: ['x', 'y'] })
  })

  it('drops envelopes from anyone but the bound peer, and they cannot ack', () => {
    const { a, b } = link()
    a.wrap('secret', 0)
    const stranger = new ReliableChannel('stranger', null)
    const fake = parse(stranger.wrap('hijack', 0))
    fake.a = 99 // pretends to acknowledge everything
    expect(a.accept(fake)).toEqual({ kind: 'foreign', from: 'stranger' })
    expect(a.unackedCount).toBe(1)
    // the guest binds to the host on first contact, then refuses others
    expect(b.accept(parse(a.due(5000, 0)[0]!))).toEqual({ kind: 'delivered', messages: ['secret'] })
    expect(b.peerId).toBe('host')
    expect(b.accept(parse(stranger.wrap('later', 0)))).toEqual({ kind: 'foreign', from: 'stranger' })
  })
})

describe('reliable relay channel: bad input', () => {
  it('rejects malformed envelopes', () => {
    expect(isEnvelope({ f: 'host', q: 0, a: 0, d: 1 })).toBe(true)
    expect(isEnvelope({ f: 'host', a: 0 })).toBe(true)
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope('x')).toBe(false)
    expect(isEnvelope({ q: 0, a: 0 })).toBe(false) // no sender id
    expect(isEnvelope({ f: '', a: 0 })).toBe(false)
    expect(isEnvelope({ f: 'h', a: -1 })).toBe(false)
    expect(isEnvelope({ f: 'h', a: 0, q: 1.5 })).toBe(false)
    expect(isEnvelope({ f: 'h', a: 0, q: '3' })).toBe(false)
    expect(isEnvelope({ f: 'h', a: Infinity })).toBe(false)
  })

  it('drops messages too far ahead instead of buffering without limit', () => {
    const { a, b } = link()
    const far = parse(a.wrap('x', 0))
    far.q = MAX_EARLY + 5
    expect(b.accept(far)).toEqual({ kind: 'overflow' })
  })

  it('survives loss and redelivery in both directions at once', () => {
    const { a, b } = link()
    const gotA: unknown[] = []
    const gotB: unknown[] = []
    const take = (into: unknown[], r: ReturnType<ReliableChannel['accept']>): void => {
      if (r.kind === 'delivered') into.push(...r.messages)
    }
    for (let i = 0; i < 20; i++) {
      const pa = a.wrap(`a${i}`, i)
      const pb = b.wrap(`b${i}`, i)
      // every third message is lost, every fourth arrives twice
      if (i % 3 !== 0) take(gotB, b.accept(parse(pa)))
      if (i % 4 === 0) take(gotB, b.accept(parse(pa)))
      if (i % 3 !== 1) take(gotA, a.accept(parse(pb)))
      if (i % 4 === 1) take(gotA, a.accept(parse(pb)))
    }
    // resend rounds with acks until both queues drain
    for (let round = 0; round < 5 && (a.unackedCount || b.unackedCount); round++) {
      const now = 10000 * (round + 1)
      for (const p of a.due(now, 0)) take(gotB, b.accept(parse(p)))
      for (const p of b.due(now, 0)) take(gotA, a.accept(parse(p)))
      a.accept(parse(b.ack()))
      b.accept(parse(a.ack()))
    }
    expect(gotB).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`))
    expect(gotA).toEqual(Array.from({ length: 20 }, (_, i) => `b${i}`))
    expect(a.unackedCount).toBe(0)
    expect(b.unackedCount).toBe(0)
  })
})

// ----------------------------------------------------------- start gate

const setup = (over: Partial<MatchSetup> = {}): MatchSetup => ({
  matchId: 1,
  fighters: ['developer', 'producer'],
  location: 'zavidovo',
  roundTime: 60,
  delay: 4,
  ...over,
})

describe('fight start gate', () => {
  it('waits for the opponent, then starts on an identical setup', () => {
    const gate = new MatchGate()
    expect(gate.check(setup())).toEqual({ state: 'waiting' })
    expect(gate.remoteReady(setup())).toBe('new')
    expect(gate.check(setup())).toEqual({ state: 'go' })
  })

  it('treats a repeated report as harmless', () => {
    const gate = new MatchGate()
    gate.remoteReady(setup())
    expect(gate.remoteReady(setup())).toBe('duplicate')
    expect(gate.check(setup())).toEqual({ state: 'go' })
  })

  it('blocks the start when fighters, arena or sync parameters differ', () => {
    const gate = new MatchGate()
    gate.remoteReady(setup({ fighters: ['producer', 'developer'], delay: 6 }))
    expect(gate.check(setup())).toEqual({ state: 'mismatch', fields: ['fighters', 'delay'] })
    expect(setupMismatch(setup(), setup({ location: 'other', roundTime: 99 }))).toEqual(['location', 'roundTime'])
  })

  it('never trusts a match reported twice with different data', () => {
    const gate = new MatchGate()
    gate.remoteReady(setup())
    expect(gate.remoteReady(setup({ location: 'other' }))).toBe('conflict')
    expect(gate.check(setup())).toEqual({ state: 'mismatch', fields: ['location'] })
  })

  it('keeps reports per match: an old match does not start a new one', () => {
    const gate = new MatchGate()
    gate.remoteReady(setup({ matchId: 1 }))
    expect(gate.check(setup({ matchId: 2 }))).toEqual({ state: 'waiting' })
    gate.forgetBefore(2)
    expect(gate.check(setup({ matchId: 1 }))).toEqual({ state: 'waiting' })
  })

  it('reports the opponent failing to load', () => {
    const gate = new MatchGate()
    gate.remoteFailed(1, 'atlas missing')
    expect(gate.check(setup())).toEqual({ state: 'failed', reason: 'atlas missing' })
  })
})

// ------------------------------------------------------------- lockstep

describe('lockstep waiting for input', () => {
  const sent: NetMessage[] = []
  const make = (): Lockstep => new Lockstep({ rtt: 0, send: (m) => sent.push(m) }, 0, 7, 3)

  it('runs the first `delay` ticks, then waits for the missing input', () => {
    const ls = make()
    const frame = createInputFrame()
    const out: [InputFrame, InputFrame] = [createInputFrame(), createInputFrame()]
    for (let t = 0; t < 3; t++) {
      expect(ls.ready(t)).toBe(true)
      ls.advance(t, frame, out)
    }
    expect(ls.ready(3)).toBe(false)
    expect(ls.waitInfo(3)).toEqual({ needTick: 3, lastReceivedTick: -1, behindBy: 4 })
    // input of another match does not unblock it
    ls.receive({ t: 'in', m: 6, k: 3, h: 1, p: 1 })
    expect(ls.ready(3)).toBe(false)
    // the right input arrives (twice: a resend) and the game continues with it
    ls.receive({ t: 'in', m: 7, k: 3, h: 2, p: 2 })
    ls.receive({ t: 'in', m: 7, k: 3, h: 2, p: 2 })
    expect(ls.ready(3)).toBe(true)
    expect(ls.waitInfo(4).lastReceivedTick).toBe(3)
    ls.advance(3, frame, out)
    expect(out[1]).toEqual({ held: 2, pressed: 2 })
  })

  it('flags a checksum mismatch', () => {
    const ls = make()
    ls.checksum(30, 111)
    ls.receive({ t: 'sum', m: 7, k: 30, s: 222 })
    expect(ls.desynced).toBe(true)
  })
})
