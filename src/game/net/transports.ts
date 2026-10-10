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

export class RelayTransport implements Transport {
  readonly kind = 'relay'
  private done = false

  constructor(
    private readonly client: MqttClient,
    private readonly outTopic: string,
    inTopic: string,
    events: TransportEvents,
  ) {
    client.on('message', (topic, payload) => {
      if (this.done || topic !== inTopic) return
      let data: unknown
      try {
        data = JSON.parse(payload.toString())
      } catch {
        return
      }
      events.message(data)
    })
    const lost = (): void => {
      if (this.done) return
      this.done = true
      events.closed('Связь с ретранслятором потеряна')
    }
    client.on('close', lost)
    client.on('offline', lost)
  }

  send(data: unknown): void {
    // QoS 1: lockstep can't afford a lost input
    if (!this.done) this.client.publish(this.outTopic, JSON.stringify(data), { qos: 1 })
  }

  close(): void {
    this.done = true
    this.client.end(false)
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
