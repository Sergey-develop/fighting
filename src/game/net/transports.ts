import type { DataConnection } from 'peerjs'
import type { MqttClient } from 'mqtt'

export interface RelayBroker {
  url: string
  username?: string
  password?: string
}

/**
 * Public MQTT brokers (WebSocket over TLS) used as a relay when a direct
 * WebRTC link can't be made — e.g. a phone on mobile internet behind carrier
 * NAT. The host listens on all of them; the guest tries them in this order
 * and the two meet on the first one that works for both.
 * shiftr.io comes first: it is on port 443, which almost every network lets
 * through; the others use ports that mobile / office networks often block.
 * (broker.emqx.io is left out: it throttles 60 messages/s down to a trickle.)
 */
export const RELAY_BROKERS: readonly RelayBroker[] = [
  { url: 'wss://public.cloud.shiftr.io:443', username: 'public', password: 'public' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://test.mosquitto.org:8081/mqtt' },
]

const RELAY_CONNECT_TIMEOUT_MS = 6000

export function relayTopic(code: string, box: string): string {
  return `vfight/v2/${code}/${box}`
}

/** A link to the other browser: direct (WebRTC) or through a relay broker. */
export interface Transport {
  readonly kind: 'p2p' | 'relay'
  send(data: unknown): void
  close(): void
}

export interface TransportEvents {
  message(data: unknown): void
  closed(reason: string): void
}

export class PeerTransport implements Transport {
  readonly kind = 'p2p'
  private done = false

  constructor(
    private readonly conn: DataConnection,
    events: TransportEvents,
  ) {
    conn.on('data', (d) => {
      if (!this.done) events.message(d)
    })
    conn.on('close', () => this.end(events, 'Соперник отключился'))
    conn.on('error', (e) => this.end(events, e.message || 'Соединение прервано'))
  }

  send(data: unknown): void {
    if (this.conn.open) void this.conn.send(data)
  }

  close(): void {
    this.done = true
    this.conn.close()
  }

  private end(events: TransportEvents, reason: string): void {
    if (this.done) return
    this.done = true
    events.closed(reason)
  }
}

/** How long a relay link may be down (reconnecting) before the game gives up. */
const RELAY_OUTAGE_MS = 45000
const RELAY_RECONNECT_MS = 1000
/** unacknowledged messages older than this are sent again */
const RELAY_RESEND_MS = 1500
const RELAY_ACK_MS = 200
const RELAY_MAX_UNACKED = 5000

/**
 * Relay envelope. Public brokers drop whatever arrives while a client is
 * reconnecting (a phone switching apps, a network blip), so the relay link
 * numbers its messages and resends until the other side acknowledges them.
 */
interface Envelope {
  /** sequence number of `d` */
  q?: number
  d?: unknown
  /** acknowledges every message with q < a */
  a: number
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null && typeof (v as Envelope).a === 'number'
}

export class RelayTransport implements Transport {
  readonly kind = 'relay'
  private done = false
  /** next sequence number to send */
  private nextOut = 0
  /** sent, not yet acknowledged: seq → [payload, last sent at] */
  private readonly unacked = new Map<number, [string, number]>()
  /** next sequence number expected from the other side */
  private nextIn = 0
  private readonly early = new Map<number, unknown>()
  private ackDirty = false
  private readonly timer: number
  private outageTimer = 0

  constructor(
    private readonly client: MqttClient,
    private readonly outTopic: string,
    inTopic: string,
    private readonly events: TransportEvents,
  ) {
    client.options.reconnectPeriod = RELAY_RECONNECT_MS
    client.on('message', (topic, payload) => {
      if (this.done || topic !== inTopic) return
      let v: unknown
      try {
        v = JSON.parse(payload.toString())
      } catch {
        return
      }
      // anything else on the inbox (another guest knocking) is not ours
      if (isEnvelope(v)) this.receive(v)
    })
    client.on('offline', () => this.down())
    client.on('close', () => this.down())
    client.on('connect', () => {
      // back after a blip: the broker lost what was in flight, send it again
      window.clearTimeout(this.outageTimer)
      this.outageTimer = 0
      this.resend(true)
    })
    this.timer = window.setInterval(() => this.tick(), RELAY_ACK_MS)
    document.addEventListener('visibilitychange', this.onVisible)
  }

  send(data: unknown): void {
    if (this.done) return
    const q = this.nextOut++
    const payload = JSON.stringify({ q, d: data, a: this.nextIn } satisfies Envelope)
    this.unacked.set(q, [payload, performance.now()])
    this.ackDirty = false
    if (this.unacked.size > RELAY_MAX_UNACKED) this.fail()
    else this.publish(payload)
  }

  /** Un-numbered message (the relay handshake before a link exists). */
  sendRaw(data: unknown): void {
    if (!this.done) this.publish(JSON.stringify(data))
  }

  close(): void {
    if (this.done) return
    this.stop()
    this.client.end(false)
  }

  private publish(payload: string): void {
    // QoS 1 for the broker hop; end-to-end delivery is ensured by the acks
    if (this.client.connected) this.client.publish(this.outTopic, payload, { qos: 1 })
  }

  private receive(e: Envelope): void {
    for (const q of this.unacked.keys()) if (q < e.a) this.unacked.delete(q)
    if (e.q === undefined) return
    this.ackDirty = true
    if (e.q < this.nextIn) return // duplicate of a resend
    this.early.set(e.q, e.d)
    while (this.early.has(this.nextIn)) {
      const d = this.early.get(this.nextIn)
      this.early.delete(this.nextIn)
      this.nextIn++
      this.events.message(d)
      if (this.done) return
    }
  }

  private tick(): void {
    if (this.done || !this.client.connected) return
    if (this.ackDirty) {
      this.ackDirty = false
      this.publish(JSON.stringify({ a: this.nextIn } satisfies Envelope))
    }
    this.resend(false)
  }

  private resend(all: boolean): void {
    const now = performance.now()
    for (const entry of this.unacked.values()) {
      if (!all && now - entry[1] < RELAY_RESEND_MS) continue
      entry[1] = now
      this.publish(entry[0])
    }
  }

  private down(): void {
    if (this.done || this.outageTimer) return
    this.outageTimer = window.setTimeout(() => this.fail(), RELAY_OUTAGE_MS)
  }

  /** A suspended page (phone screen off, app switched) gets a fresh grace period. */
  private readonly onVisible = (): void => {
    if (document.visibilityState !== 'visible' || this.done || !this.outageTimer) return
    window.clearTimeout(this.outageTimer)
    this.outageTimer = window.setTimeout(() => this.fail(), RELAY_OUTAGE_MS)
    if (!this.client.connected) this.client.reconnect()
  }

  private fail(): void {
    if (this.done) return
    this.stop()
    this.client.end(true)
    this.events.closed('Связь с ретранслятором потеряна')
  }

  private stop(): void {
    this.done = true
    window.clearInterval(this.timer)
    window.clearTimeout(this.outageTimer)
    document.removeEventListener('visibilitychange', this.onVisible)
  }
}

/** Connect to a relay broker (the MQTT client is loaded on demand). */
export async function connectRelay(broker: RelayBroker): Promise<MqttClient> {
  // the browser build of mqtt only has a default export; Node's has named ones
  const mod = (await import('mqtt')) as typeof import('mqtt') & { default?: typeof import('mqtt') }
  const connect = mod.default?.connect ?? mod.connect
  return new Promise((resolve, reject) => {
    const client = connect(broker.url, {
      username: broker.username,
      password: broker.password,
      connectTimeout: RELAY_CONNECT_TIMEOUT_MS,
      reconnectPeriod: 0,
      clean: true,
    })
    const fail = (e?: Error): void => {
      client.removeListener('error', fail)
      client.removeListener('close', onClose)
      client.end(true)
      reject(e ?? new Error('relay unavailable'))
    }
    const onClose = (): void => fail()
    client.once('connect', () => {
      client.removeListener('error', fail)
      client.removeListener('close', onClose)
      // later errors also arrive as 'close' / 'offline'; an unhandled 'error' would throw
      client.on('error', () => {})
      resolve(client)
    })
    client.once('error', fail)
    client.once('close', onClose)
  })
}

export function subscribe(client: MqttClient, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()))
  })
}
