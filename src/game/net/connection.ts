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

/** Bumped whenever the message format changes: both sides must run the same build. */
export const PROTOCOL_VERSION = 2

/** Messages exchanged between the two browsers. */
export type NetMessage =
  | { t: 'hello'; v: number }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  /** character select: cursor position and lock-in of the sender's seat */
  | { t: 'seat'; cursor: number; ready: boolean }
  /** location select: the host's carousel position */
  | { t: 'loc'; i: number }
  /** host → guest: the match is set up, go to the VS screen */
  | { t: 'start'; fighters: [string, string]; location: string; roundTime: number; delay: number }
  /** both sides back to character select */
  | { t: 'select' }
  /** the sender wants a rematch */
  | { t: 'rematch' }
  /** input of the sender's seat for tick `k` of match `m` */
  | { t: 'in'; m: number; k: number; h: number; p: number }
  /** state checksum after tick `k` of match `m` (desync detection) */
  | { t: 'sum'; m: number; k: number; s: number }
  | { t: 'bye' }

export type GameMessage = Extract<NetMessage, { t: 'in' | 'sum' }>

export type ConnectionStatus = 'idle' | 'opening' | 'waiting' | 'connecting' | 'connected' | 'closed'

export type Role = 'host' | 'guest'

const PEER_PREFIX = 'vfight-room-'
/** no 0/O, 1/I/L — codes are read aloud and typed by hand */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const PING_INTERVAL_MS = 1000
/** guest: give the direct link this long before also trying the relay */
const P2P_GRACE_MS = 4000
const CONNECT_TIMEOUT_MS = 25000
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
  private transport: Transport | null = null
  /** links being tried that are not the active one yet */
  private candidates: Transport[] = []
  private peer: Peer | null = null
  /** host: relay clients listening for a guest */
  private listeners: MqttClient[] = []
  private pingTimer = 0
  private connectTimer = 0
  private graceTimer = 0
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
    peer.on('open', opened)
    peer.on('connection', (c) => {
      if (!alive() || this.transport) {
        c.on('open', () => c.close())
        return
      }
      const t: Transport = new PeerTransport(c, this.events(session, () => t))
      this.candidates.push(t)
      c.on('open', () => {
        if (alive() && !this.transport) this.adopt(t)
        else t.close()
      })
    })
    peer.on('error', (e) => {
      if (!alive()) return
      if (e.type === 'unavailable-id' && this.status === 'opening') {
        this.host() // code collision: try another one
        return
      }
      peerFail()
    })
    peer.on('disconnected', () => {
      if (alive()) peerFail()
    })

    const inbox = relayTopic(this.code, 'h')
    for (const url of RELAY_BROKERS) {
      connectRelay(url)
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
            this.listeners = this.listeners.filter((c) => c !== client)
            const t: Transport = new RelayTransport(client, relayTopic(this.code, `g-${d.id}`), inbox, this.events(session, () => t))
            this.adopt(t)
          })
          opened()
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
    this.setStatus('connecting')

    let relayStarted = false
    const startRelay = (): void => {
      if (relayStarted || !alive() || this.transport) return
      relayStarted = true
      this.joinRelays(session)
    }

    const peer = new Peer(PEER_OPTIONS)
    this.peer = peer
    peer.on('open', () => {
      if (!alive()) return
      const c = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' })
      // adopted once the host greets on it (see events)
      const t: Transport = new PeerTransport(c, this.events(session, () => t))
      this.candidates.push(t)
    })
    // PeerJS blocked, or the room is only reachable through a relay
    peer.on('error', startRelay)
    this.graceTimer = window.setTimeout(startRelay, P2P_GRACE_MS)
    this.connectTimer = window.setTimeout(() => {
      if (alive() && !this.transport) this.lost('Не удалось подключиться: комната не найдена или соперник недоступен')
    }, CONNECT_TIMEOUT_MS)
  }

  private joinRelays(session: number): void {
    const id = Math.random().toString(36).slice(2, 10)
    const inbox = relayTopic(this.code, `g-${id}`)
    const hostInbox = relayTopic(this.code, 'h')
    for (const url of RELAY_BROKERS) {
      connectRelay(url)
        .then(async (client) => {
          if (this.session !== session || this.transport) {
            client.end(true)
            return
          }
          const t: Transport = new RelayTransport(client, hostInbox, inbox, this.events(session, () => t))
          this.candidates.push(t)
          await subscribe(client, inbox)
          const join: JoinMessage = { t: 'join', id }
          t.send(join)
        })
        .catch(() => {})
    }
  }

  // ------------------------------------------------------------- traffic

  send(m: NetMessage): void {
    this.transport?.send(m)
  }

  /** Leave the room (tells the other side). */
  leave(): void {
    const t = this.transport
    if (t && this.connected) {
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
    this.send({ t: 'hello', v: PROTOCOL_VERSION })
    this.send({ t: 'ping', at: performance.now() })
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: performance.now() }), PING_INTERVAL_MS)
    this.setStatus('connected')
  }

  private receive(m: NetMessage): void {
    switch (m.t) {
      case 'hello':
        if (m.v !== PROTOCOL_VERSION) this.lost('У соперника другая версия игры — обновите страницу')
        return
      case 'ping':
        this.send({ t: 'pong', at: m.at })
        return
      case 'pong': {
        const sample = performance.now() - m.at
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2
        this.emitStatus()
        return
      }
      case 'bye':
        this.lost('Соперник вышел')
        return
      case 'in':
      case 'sum':
        if (this.gameHandler) this.gameHandler(m)
        else this.gameInbox.push(m)
        return
    }
    for (const cb of this.messageListeners) cb(m)
  }

  private lost(reason: string): void {
    this.reset()
    this.error = reason
    this.setStatus('closed')
  }

  private reset(): void {
    this.session++
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.connectTimer)
    window.clearTimeout(this.graceTimer)
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
