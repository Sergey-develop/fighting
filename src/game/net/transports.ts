import type { DataConnection } from 'peerjs'
import type { MqttClient } from 'mqtt'
import { maskId, netDiag } from './diag'
import { ReliableChannel, isEnvelope, type Envelope } from './reliable'

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
    conn.on('open', () => netDiag('webrtc datachannel open', this.rtcState()))
    conn.on('data', (d) => {
      if (!this.done) events.message(d)
    })
    conn.on('close', () => {
      netDiag('webrtc datachannel close', { ...this.rtcState(), byUs: this.done })
      this.end(events, 'Соперник отключился')
    })
    conn.on('error', (e) => {
      netDiag('webrtc datachannel error', { type: (e as { type?: string }).type ?? '', message: e.message, ...this.rtcState() })
      this.end(events, e.message || 'Соединение прервано')
    })
    conn.on('iceStateChanged', (state) => netDiag('webrtc ice state', { ice: state, ...this.rtcState() }))
  }

  /** RTCPeerConnection state, when PeerJS has created it already. */
  private rtcState(): Record<string, unknown> {
    const pc = (this.conn as { peerConnection?: RTCPeerConnection | null }).peerConnection
    return pc ? { pc: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState } : { pc: 'none' }
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
 * Link through an MQTT relay. Delivery, order, duplicates and the sender check
 * are handled by ReliableChannel; this class moves its envelopes and survives
 * reconnects (a phone switching apps, a network blip).
 */
export class RelayTransport implements Transport {
  readonly kind = 'relay'
  private done = false
  private readonly channel: ReliableChannel
  private readonly timer: number
  private outageTimer = 0
  /** senders already reported as foreign (logged once each) */
  private readonly foreign = new Set<string>()
  private duplicates = 0

  constructor(
    private readonly client: MqttClient,
    private readonly outTopic: string,
    inTopic: string,
    private readonly events: TransportEvents,
    /** our id in envelopes */
    selfId: string,
    /** the accepted peer; null = bind to the first sender */
    peerId: string | null,
  ) {
    this.channel = new ReliableChannel(selfId, peerId)
    client.options.reconnectPeriod = RELAY_RECONNECT_MS
    client.on('message', (topic, payload) => {
      if (this.done || topic !== inTopic) return
      let v: unknown
      try {
        v = JSON.parse(payload.toString())
      } catch {
        netDiag('relay: unreadable message dropped', { bytes: payload.length })
        return
      }
      // raw messages on the inbox (another guest knocking) are not part of the link
      if (isEnvelope(v)) this.receive(v)
    })
    client.on('offline', () => {
      netDiag('relay offline', { broker: brokerHost(client), unacked: this.channel.unackedCount })
      this.down()
    })
    client.on('close', () => this.down())
    client.on('reconnect', () => netDiag('relay reconnecting', { broker: brokerHost(client) }))
    client.on('connect', () => {
      netDiag('relay reconnected', { broker: brokerHost(client), resending: this.channel.unackedCount })
      // back after a blip: the broker lost what was in flight, send it again
      window.clearTimeout(this.outageTimer)
      this.outageTimer = 0
      for (const p of this.channel.due(performance.now(), 0, true)) this.publish(p)
    })
    this.timer = window.setInterval(() => this.tick(), RELAY_ACK_MS)
    document.addEventListener('visibilitychange', this.onVisible)
  }

  send(data: unknown): void {
    if (this.done) return
    const payload = this.channel.wrap(data, performance.now())
    if (this.channel.unackedCount > RELAY_MAX_UNACKED) this.fail()
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
    if (!this.client.connected) return
    this.client.publish(this.outTopic, payload, { qos: 1 }, (err) => {
      if (err) netDiag('relay publish error', { broker: brokerHost(this.client), error: err.message })
    })
  }

  private receive(e: Envelope): void {
    const r = this.channel.accept(e)
    if (r.kind === 'foreign') {
      if (!this.foreign.has(r.from)) {
        this.foreign.add(r.from)
        netDiag('relay: message from a foreign sender dropped', { from: maskId(r.from), bound: maskId(this.channel.peerId) })
      }
      return
    }
    if (r.kind === 'duplicate') {
      this.duplicates++
      if (this.duplicates === 1 || this.duplicates % 100 === 0) netDiag('relay: duplicates dropped', { total: this.duplicates })
      return
    }
    if (r.kind === 'overflow') {
      netDiag('relay: message far out of order dropped (will be resent)', { seq: e.q })
      return
    }
    if (r.kind !== 'delivered') return
    for (const d of r.messages) {
      this.events.message(d)
      if (this.done) return
    }
  }

  private tick(): void {
    if (this.done || !this.client.connected) return
    if (this.channel.ackDirty) this.publish(this.channel.ack())
    for (const p of this.channel.due(performance.now(), RELAY_RESEND_MS)) this.publish(p)
  }

  private down(): void {
    if (this.done || this.outageTimer) return
    netDiag('relay link down, waiting for reconnect', { broker: brokerHost(this.client), giveUpAfterMs: RELAY_OUTAGE_MS })
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
    netDiag('relay link given up', { broker: brokerHost(this.client), unacked: this.channel.unackedCount })
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
      netDiag('relay connect failed', { broker: hostOf(broker.url), error: e?.message ?? 'closed' })
      client.removeListener('error', fail)
      client.removeListener('close', onClose)
      client.end(true)
      reject(e ?? new Error('relay unavailable'))
    }
    const onClose = (): void => fail()
    const started = performance.now()
    client.once('connect', () => {
      netDiag('relay connected', { broker: brokerHost(client), ms: Math.round(performance.now() - started) })
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
    client.subscribe(topic, { qos: 1 }, (err) => {
      // the topic holds the room code: log only which inbox it is
      netDiag(err ? 'relay subscribe failed' : 'relay subscribed', {
        broker: brokerHost(client),
        inbox: topic.endsWith('/h') ? 'host' : 'guest',
        ...(err ? { error: err.message } : {}),
      })
      if (err) reject(err)
      else resolve()
    })
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function brokerHost(client: MqttClient): string {
  const o = client.options as { hostname?: string; host?: string; port?: number }
  return `${o.hostname ?? o.host ?? '?'}:${o.port ?? ''}`
}
