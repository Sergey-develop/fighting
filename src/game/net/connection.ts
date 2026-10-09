import Peer, { type DataConnection, type PeerError } from 'peerjs'

/** Bumped whenever the message format changes: both sides must run the same build. */
export const PROTOCOL_VERSION = 1

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
const CONNECT_TIMEOUT_MS = 15000

export function randomRoomCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function describeError(e: PeerError<string> | Error): string {
  const type = 'type' in e ? String(e.type) : ''
  switch (type) {
    case 'peer-unavailable':
      return 'Комната не найдена — проверьте код'
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Нет связи с сервером соединения — проверьте интернет'
    case 'browser-incompatible':
      return 'Браузер не поддерживает WebRTC'
    case 'webrtc':
      return 'Не удалось установить прямое соединение (возможно, мешает NAT / файрвол)'
    default:
      return e.message || 'Ошибка соединения'
  }
}

/**
 * Peer-to-peer link between two browsers (WebRTC data channel via PeerJS).
 * The public PeerJS broker is only used to find each other; game traffic goes
 * directly between the players, so no own server is needed.
 */
export class NetConnection {
  status: ConnectionStatus = 'idle'
  role: Role = 'host'
  code = ''
  /** smoothed round-trip time, ms */
  rtt = 0
  error = ''

  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private pingTimer = 0
  private connectTimer = 0
  private readonly statusListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(m: NetMessage) => void>()
  /** in-fight traffic that arrived before the fight session subscribed */
  private gameInbox: GameMessage[] = []
  private gameHandler: ((m: GameMessage) => void) | null = null

  get connected(): boolean {
    return this.status === 'connected'
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

  /** Create a room and wait for the other player. */
  host(): void {
    this.reset()
    this.role = 'host'
    this.code = randomRoomCode()
    this.setStatus('opening')
    const peer = new Peer(PEER_PREFIX + this.code, { debug: 0 })
    this.peer = peer
    // a destroyed peer still fires events: only the current one counts
    const current = (): boolean => this.peer === peer
    peer.on('open', () => {
      if (current()) this.setStatus('waiting')
    })
    peer.on('connection', (c) => {
      if (!current()) return
      if (this.conn) {
        // the room is full
        c.on('open', () => c.close())
        return
      }
      this.attach(c)
    })
    peer.on('error', (e) => {
      if (!current()) return
      if (e.type === 'unavailable-id') {
        this.host() // code collision: try another one
        return
      }
      this.fail(e)
    })
    peer.on('disconnected', () => {
      // lost the broker; an established game keeps running peer-to-peer
      if (current() && !this.connected) this.fail(new Error('Соединение с сервером потеряно'))
    })
  }

  /** Join the room with the given code. */
  join(rawCode: string): void {
    this.reset()
    this.role = 'guest'
    this.code = normalizeRoomCode(rawCode)
    this.setStatus('opening')
    const peer = new Peer({ debug: 0 })
    this.peer = peer
    const current = (): boolean => this.peer === peer
    peer.on('open', () => {
      if (!current()) return
      this.setStatus('connecting')
      this.attach(peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' }))
      this.connectTimer = window.setTimeout(() => {
        if (!this.connected) this.fail(new Error('Не удалось подключиться: соперник не отвечает'))
      }, CONNECT_TIMEOUT_MS)
    })
    peer.on('error', (e) => {
      if (current()) this.fail(e)
    })
  }

  send(m: NetMessage): void {
    if (this.conn?.open) void this.conn.send(m)
  }

  /** Leave the room (tells the other side). */
  leave(): void {
    if (this.connected) this.send({ t: 'bye' })
    // let the goodbye flush before tearing the channel down
    const conn = this.conn
    const peer = this.peer
    this.conn = null
    this.peer = null
    window.setTimeout(() => {
      conn?.close()
      peer?.destroy()
    }, 100)
    this.reset()
    this.setStatus('idle')
  }

  private attach(c: DataConnection): void {
    this.conn = c
    c.on('open', () => {
      if (this.conn !== c) return
      window.clearTimeout(this.connectTimer)
      this.send({ t: 'hello', v: PROTOCOL_VERSION })
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: performance.now() }), PING_INTERVAL_MS)
      this.send({ t: 'ping', at: performance.now() })
      this.setStatus('connected')
    })
    c.on('data', (data) => {
      if (this.conn === c) this.receive(data as NetMessage)
    })
    c.on('close', () => {
      if (this.conn !== c) return
      this.lost('Соперник отключился')
    })
    c.on('error', (e) => {
      if (this.conn !== c) return
      this.lost(e.message || 'Соединение прервано')
    })
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
    const peer = this.peer
    const conn = this.conn
    this.conn = null
    this.peer = null
    conn?.close()
    peer?.destroy()
    this.reset()
    this.error = reason
    this.setStatus('closed')
  }

  private fail(e: PeerError<string> | Error): void {
    this.lost(describeError(e))
  }

  private reset(): void {
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.connectTimer)
    this.conn?.close()
    this.peer?.destroy()
    this.conn = null
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
