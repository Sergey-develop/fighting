import Peer from 'peerjs'
import type { MqttClient } from 'mqtt'
import {
  PeerTransport,
  RELAY_BROKERS,
  RelayTransport,
  connectRelay,
  relayTopic,
  subscribe,
  type Transport,
  type TransportEvents,
} from './transports'
import { maskCode, maskId, netDiag } from './diag'
import { Handshake } from './handshake'

/** Bumped whenever the message format changes: both sides must run the same build. */
export const PROTOCOL_VERSION = 3

/** Messages exchanged between the two browsers. */
export type NetMessage =
  /** link handshake, see handshake.ts */
  | { t: 'hello'; v: number }
  | { t: 'ready' }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  /** character select: cursor position and lock-in of the sender's seat */
  | { t: 'seat'; cursor: number; ready: boolean }
  /** location select: the host's carousel position */
  | { t: 'loc'; i: number }
  /** host → guest: match `m` is set up, go to the VS screen */
  | { t: 'start'; m: number; fighters: [string, string]; location: string; roundTime: number; delay: number }
  /** the sender loaded match `m` with this setup (see match-gate.ts) */
  | { t: 'fightready'; m: number; fighters: [string, string]; location: string; roundTime: number; delay: number }
  /** the sender could not load match `m` */
  | { t: 'fightfail'; m: number; reason: string }
  /** both sides back to character select (after match `m`) */
  | { t: 'select'; m: number }
  /** the sender wants a rematch of match `m` */
  | { t: 'rematch'; m: number }
  /** input of the sender's seat for tick `k` of match `m` */
  | { t: 'in'; m: number; k: number; h: number; p: number }
  /** state checksum after tick `k` of match `m` (desync detection) */
  | { t: 'sum'; m: number; k: number; s: number }
  | { t: 'bye' }

export type GameMessage = Extract<NetMessage, { t: 'in' | 'sum' }>

/**
 * 'linking': a transport was picked and the handshake is running — the link is
 * NOT usable yet. 'connected': messages went through in both directions.
 */
export type ConnectionStatus = 'idle' | 'opening' | 'waiting' | 'connecting' | 'linking' | 'connected' | 'closed'

export type Role = 'host' | 'guest'

const PEER_PREFIX = 'vfight-room-'
/** no 0/O, 1/I/L — codes are read aloud and typed by hand */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const PING_INTERVAL_MS = 1000
/** guest: give the direct link this long before also trying the relay */
const P2P_GRACE_MS = 4000
const CONNECT_TIMEOUT_MS = 30000
/** guest: how long to wait for the host's answer on one relay before trying the next */
const RELAY_ANSWER_MS = 4000
/** the handshake on the adopted link must finish within this time */
const HANDSHAKE_TIMEOUT_MS = 10000
/** the TURN servers in PeerJS' default config are dead and only slow ICE down */
const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
  },
}

export function randomRoomCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Relay handshake: the guest knocks on the host's inbox with its own inbox id. */
interface JoinMessage {
  t: 'join'
  id: string
}

function isJoin(d: unknown): d is JoinMessage {
  return typeof d === 'object' && d !== null && (d as JoinMessage).t === 'join' && typeof (d as JoinMessage).id === 'string'
}

/**
 * Link between two browsers. First choice is a direct WebRTC data channel
 * (PeerJS; its public broker only introduces the players). When that can't be
 * established — mobile carrier NAT, blocked broker — traffic goes through a
 * public MQTT relay instead. No own server is needed either way.
 */
export class NetConnection {
  status: ConnectionStatus = 'idle'
  role: Role = 'host'
  code = ''
  /** smoothed round-trip time, ms */
  rtt = 0
  error = ''

  /** invalidates callbacks of an earlier host()/join() */
  private session = 0
  /** lobby diagnostics: PeerJS broker reachable, relays reachable */
  p2pReady = false
  relaysReady = 0
  relayTried = false
  private transport: Transport | null = null
  /** links being tried that are not the active one yet */
  private candidates: Transport[] = []
  private peer: Peer | null = null
  /** host: relay clients listening for a guest */
  private listeners: MqttClient[] = []
  private pingTimer = 0
  private connectTimer = 0
  private graceTimer = 0
  private handshakeTimer = 0
  private handshake: Handshake | null = null
  private firstPong = true
  private readonly statusListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(m: NetMessage) => void>()
  /** in-fight traffic that arrived before the fight session subscribed */
  private gameInbox: GameMessage[] = []
  private gameHandler: ((m: GameMessage) => void) | null = null

  get connected(): boolean {
    return this.status === 'connected'
  }

  /** 'p2p' = direct, 'relay' = through an MQTT broker */
  get linkKind(): Transport['kind'] | null {
    return this.transport?.kind ?? null
  }

  /** Seat of this browser: the host is always player 1. */
  get localSlot(): 0 | 1 {
    return this.role === 'host' ? 0 : 1
  }

  onStatus(cb: () => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  onMessage(cb: (m: NetMessage) => void): () => void {
    this.messageListeners.add(cb)
    return () => this.messageListeners.delete(cb)
  }

  /** The fight session takes over in-fight messages; buffered ones are replayed. */
  setGameHandler(cb: ((m: GameMessage) => void) | null): void {
    this.gameHandler = cb
    if (!cb) return
    const queued = this.gameInbox
    this.gameInbox = []
    for (const m of queued) cb(m)
  }

  // ------------------------------------------------------------------ host

  /** Create a room and wait for the other player. */
  host(): void {
    this.reset()
    const session = this.session
    const alive = (): boolean => this.session === session
    this.role = 'host'
    this.code = randomRoomCode()
    netDiag('host: creating room', { room: maskCode(this.code), relays: RELAY_BROKERS.length })
    this.setStatus('opening')

    // the room is reachable through PeerJS and through every relay that answers
    let pending = 1 + RELAY_BROKERS.length
    const opened = (): void => {
      if (alive() && this.status === 'opening') this.setStatus('waiting')
    }
    const failed = (): void => {
      if (!alive()) return
      pending--
      if (pending === 0 && this.status === 'opening') this.lost('Нет связи с серверами соединения — проверьте интернет')
    }

    const peer = new Peer(PEER_PREFIX + this.code, PEER_OPTIONS)
    this.peer = peer
    let peerFailed = false
    const peerFail = (): void => {
      if (peerFailed) return
      peerFailed = true
      failed()
    }
    peer.on('open', () => {
      if (!alive()) return
      netDiag('host: peerjs broker open')
      this.p2pReady = true
      opened()
      this.emitStatus()
    })
    peer.on('connection', (c) => {
      if (!alive() || this.transport) {
        netDiag('host: extra webrtc connection refused', { linked: this.transport?.kind ?? null })
        c.on('open', () => c.close())
        return
      }
      netDiag('host: incoming webrtc connection')
      const t: Transport = new PeerTransport(c, this.events(session, () => t))
      this.candidates.push(t)
      c.on('open', () => {
        if (alive() && !this.transport) this.adopt(t)
        else t.close()
      })
    })
    peer.on('error', (e) => {
      if (!alive()) return
      netDiag('host: peerjs error', { type: e.type, status: this.status })
      if (e.type === 'unavailable-id' && this.status === 'opening') {
        this.host() // code collision: try another one
        return
      }
      peerFail()
    })
    peer.on('disconnected', () => {
      // after a relay was picked we close PeerJS ourselves: not a failure
      if (!alive() || this.transport) return
      netDiag('host: peerjs broker disconnected', { status: this.status })
      peerFail()
    })

    const inbox = relayTopic(this.code, 'h')
    /** the host's sender id in relay envelopes */
    const hostId = Math.random().toString(36).slice(2, 10)
    for (const broker of RELAY_BROKERS) {
      connectRelay(broker)
        .then(async (client) => {
          if (!alive()) {
            client.end(true)
            return
          }
          this.listeners.push(client)
          await subscribe(client, inbox)
          client.on('message', (topic, payload) => {
            if (!alive() || this.transport || topic !== inbox) return
            let d: unknown
            try {
              d = JSON.parse(payload.toString())
            } catch {
              return
            }
            if (!isJoin(d)) return
            netDiag('host: guest knocked through relay', { guest: maskId(d.id) })
            this.listeners = this.listeners.filter((c) => c !== client)
            // bound to this guest: envelopes from anyone else on the inbox are dropped
            const t: Transport = new RelayTransport(client, relayTopic(this.code, `g-${d.id}`), inbox, this.events(session, () => t), hostId, d.id)
            this.adopt(t)
          })
          this.relaysReady++
          opened()
          this.emitStatus()
        })
        .catch(failed)
    }
  }

  // ----------------------------------------------------------------- guest

  /** Join the room with the given code. */
  join(rawCode: string): void {
    this.reset()
    const session = this.session
    const alive = (): boolean => this.session === session
    this.role = 'guest'
    this.code = normalizeRoomCode(rawCode)
    netDiag('guest: joining room', { room: maskCode(this.code) })
    this.setStatus('connecting')

    let relayStarted = false
    const startRelay = (): void => {
      if (relayStarted || !alive() || this.transport) return
      relayStarted = true
      netDiag('guest: trying relays', { linked: this.transport !== null })
      this.relayTried = true
      this.emitStatus()
      void this.joinRelays(session)
    }

    const peer = new Peer(PEER_OPTIONS)
    this.peer = peer
    peer.on('open', () => {
      if (!alive()) return
      netDiag('guest: peerjs broker open, opening webrtc to host')
      this.p2pReady = true
      this.emitStatus()
      const c = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' })
      // adopted once the host greets on it (see events)
      const t: Transport = new PeerTransport(c, this.events(session, () => t))
      this.candidates.push(t)
    })
    // PeerJS blocked, or the room is only reachable through a relay
    peer.on('error', (e) => {
      if (alive()) netDiag('guest: peerjs error', { type: e.type })
      startRelay()
    })
    this.graceTimer = window.setTimeout(startRelay, P2P_GRACE_MS)
    this.connectTimer = window.setTimeout(() => {
      if (!alive() || this.transport) return
      netDiag('guest: gave up connecting', { afterMs: CONNECT_TIMEOUT_MS, p2pBroker: this.p2pReady, relaysKnocked: this.relaysReady })
      this.lost('Не удалось подключиться: комната не найдена или соперник недоступен')
    }, CONNECT_TIMEOUT_MS)
  }

  /** Knock on the host through each relay in turn until it answers on one. */
  private async joinRelays(session: number): Promise<void> {
    const id = Math.random().toString(36).slice(2, 10)
    const inbox = relayTopic(this.code, `g-${id}`)
    const hostInbox = relayTopic(this.code, 'h')
    const done = (): boolean => this.session !== session || this.transport !== null
    for (const broker of RELAY_BROKERS) {
      if (done()) return
      let client: MqttClient
      try {
        client = await connectRelay(broker)
      } catch {
        continue
      }
      if (done()) {
        client.end(true)
        return
      }
      // the guest binds to the first sender on its private inbox: the host
      const t: RelayTransport = new RelayTransport(client, hostInbox, inbox, this.events(session, () => t), id, null)
      this.candidates.push(t)
      try {
        await subscribe(client, inbox)
      } catch {
        t.close()
        continue
      }
      const join: JoinMessage = { t: 'join', id }
      t.sendRaw(join)
      netDiag('guest: knocked on host through relay', { broker: broker.url.replace(/^wss:\/\//, ''), me: maskId(id) })
      this.relaysReady++
      this.emitStatus()
      // the host answers with 'hello' on this relay (adopted in events)
      await new Promise((r) => window.setTimeout(r, RELAY_ANSWER_MS))
      if (done()) return
      netDiag('guest: no answer through relay, trying next', { broker: broker.url.replace(/^wss:\/\//, ''), waitedMs: RELAY_ANSWER_MS })
      t.close()
      this.candidates = this.candidates.filter((c) => c !== t)
    }
  }

  // ------------------------------------------------------------- traffic

  send(m: NetMessage): void {
    this.transport?.send(m)
  }

  /** Leave the room (tells the other side). */
  leave(): void {
    const t = this.transport
    netDiag(`${this.role}: leaving`, { status: this.status })
    if (t && (this.connected || this.status === 'linking')) {
      const bye: NetMessage = { t: 'bye' }
      t.send(bye)
      this.transport = null
      // let the goodbye flush before tearing the link down
      window.setTimeout(() => t.close(), 150)
    }
    this.reset()
    this.setStatus('idle')
  }

  private events(session: number, self: () => Transport): TransportEvents {
    return {
      message: (d) => {
        if (this.session !== session) return
        const t = self()
        const m = d as NetMessage
        if (this.transport === t) this.receive(m)
        else if (!this.transport && this.role === 'guest' && m.t === 'hello') {
          // the host picked this link
          this.adopt(t)
          this.receive(m)
        }
      },
      closed: (reason) => {
        if (this.session !== session) return
        const t = self()
        if (this.transport === t) this.lost(reason)
        else this.candidates = this.candidates.filter((c) => c !== t)
      },
    }
  }

  /** Make `t` the active link and drop every other attempt. */
  private adopt(t: Transport): void {
    this.transport = t
    window.clearTimeout(this.connectTimer)
    window.clearTimeout(this.graceTimer)
    for (const c of this.candidates) if (c !== t) c.close()
    this.candidates = []
    for (const c of this.listeners) c.end(true)
    this.listeners = []
    // a relayed game doesn't need the PeerJS broker any more
    if (t.kind === 'relay') {
      this.peer?.destroy()
      this.peer = null
    }
    netDiag(`${this.role}: transport selected`, { kind: t.kind })
    this.setStatus('linking')
    this.handshake = new Handshake(this.role, PROTOCOL_VERSION, (m) => {
      netDiag(`${this.role}: handshake send`, { msg: m.t })
      this.send(m)
    })
    this.handshake.begin()
    this.send({ t: 'ping', at: performance.now() })
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: performance.now() }), PING_INTERVAL_MS)
    // e.g. the guest already moved on to another relay, or one direction is blocked
    this.handshakeTimer = window.setTimeout(() => {
      netDiag(`${this.role}: handshake timed out`, { kind: t.kind, afterMs: HANDSHAKE_TIMEOUT_MS })
      this.lost('Канал не подтвердился: сообщения не проходят в обе стороны — попробуйте ещё раз')
    }, HANDSHAKE_TIMEOUT_MS)
  }

  private receive(m: NetMessage): void {
    switch (m.t) {
      case 'hello':
      case 'ready': {
        const event = this.handshake?.handle(m)
        netDiag(`${this.role}: handshake receive`, { msg: m.t, event })
        if (event === 'version-mismatch') this.lost('У соперника другая версия игры — обновите страницу')
        else if (event === 'connected') {
          window.clearTimeout(this.handshakeTimer)
          netDiag(`${this.role}: link verified in both directions`, { kind: this.linkKind })
          this.setStatus('connected')
        }
        return
      }
      case 'ping':
        this.send({ t: 'pong', at: m.at })
        return
      case 'pong': {
        const sample = performance.now() - m.at
        if (this.firstPong) {
          this.firstPong = false
          netDiag(`${this.role}: first ping round trip`, { kind: this.linkKind, rttMs: Math.round(sample) })
        }
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2
        this.emitStatus()
        return
      }
      case 'bye':
        this.lost('Соперник вышел')
        return
    }
    // until the handshake is done the link is not trusted: no game traffic
    if (this.status !== 'connected') {
      netDiag(`${this.role}: message before the link was verified dropped`, { msg: m.t, status: this.status })
      return
    }
    switch (m.t) {
      case 'in':
      case 'sum':
        if (this.gameHandler) this.gameHandler(m)
        else this.gameInbox.push(m)
        return
    }
    for (const cb of this.messageListeners) cb(m)
  }

  private lost(reason: string): void {
    netDiag(`${this.role}: connection lost`, { reason, status: this.status, kind: this.linkKind })
    this.reset()
    this.error = reason
    this.setStatus('closed')
  }

  private reset(): void {
    this.session++
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.connectTimer)
    window.clearTimeout(this.graceTimer)
    window.clearTimeout(this.handshakeTimer)
    this.handshake = null
    this.firstPong = true
    this.transport?.close()
    this.transport = null
    for (const c of this.candidates) c.close()
    this.candidates = []
    for (const c of this.listeners) c.end(true)
    this.listeners = []
    this.peer?.destroy()
    this.peer = null
    this.rtt = 0
    this.error = ''
    this.gameInbox = []
    this.p2pReady = false
    this.relaysReady = 0
    this.relayTried = false
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s
    this.emitStatus()
  }

  private emitStatus(): void {
    for (const cb of this.statusListeners) cb()
  }
}

export const net = new NetConnection()
