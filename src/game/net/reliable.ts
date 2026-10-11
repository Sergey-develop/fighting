/**
 * Reliable, ordered delivery over the relay. Public brokers drop whatever
 * arrives while a client is reconnecting, may deliver twice, and anyone who
 * knows the room code can publish to the host's inbox — so every envelope
 * carries its sender id, a sequence number and an acknowledgement.
 */

export interface Envelope {
  /** sender id */
  f: string
  /** sequence number of `d` (absent = pure acknowledgement) */
  q?: number
  d?: unknown
  /** acknowledges every message with q < a */
  a: number
}

const isSeq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

export function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Envelope
  return typeof e.f === 'string' && e.f.length > 0 && isSeq(e.a) && (e.q === undefined || isSeq(e.q))
}

/** Out-of-order messages kept at most this far ahead of the next expected one. */
export const MAX_EARLY = 4096

export type AcceptResult =
  | { kind: 'delivered'; messages: unknown[] }
  /** an old sequence number: already delivered (a resend) */
  | { kind: 'duplicate' }
  /** out of order: kept until the gap is filled */
  | { kind: 'buffered' }
  /** pure acknowledgement */
  | { kind: 'ack' }
  /** from someone other than the bound peer */
  | { kind: 'foreign'; from: string }
  /** too far ahead of what we expect: dropped, the sender resends it later */
  | { kind: 'overflow' }

export class ReliableChannel {
  private nextOut = 0
  /** sent, not yet acknowledged: seq → [payload, last sent at] */
  private readonly unacked = new Map<number, [string, number]>()
  private nextIn = 0
  private readonly early = new Map<number, unknown>()
  /** something arrived that we haven't acknowledged yet */
  ackDirty = false

  constructor(
    readonly selfId: string,
    /** the other side; null = bind to the first sender (the guest learns the host this way) */
    public peerId: string | null,
  ) {}

  get unackedCount(): number {
    return this.unacked.size
  }

  /** Envelope for `data`; kept until acknowledged. */
  wrap(data: unknown, now: number): string {
    const q = this.nextOut++
    const payload = JSON.stringify({ f: this.selfId, q, d: data, a: this.nextIn } satisfies Envelope)
    this.unacked.set(q, [payload, now])
    this.ackDirty = false // the envelope carries the acknowledgement
    return payload
  }

  /** Pure acknowledgement envelope. */
  ack(): string {
    this.ackDirty = false
    return JSON.stringify({ f: this.selfId, a: this.nextIn } satisfies Envelope)
  }

  accept(e: Envelope): AcceptResult {
    if (this.peerId === null) this.peerId = e.f
    else if (e.f !== this.peerId) return { kind: 'foreign', from: e.f }
    for (const q of this.unacked.keys()) if (q < e.a) this.unacked.delete(q)
    if (e.q === undefined) return { kind: 'ack' }
    this.ackDirty = true
    if (e.q < this.nextIn || this.early.has(e.q)) return { kind: 'duplicate' }
    if (e.q >= this.nextIn + MAX_EARLY) return { kind: 'overflow' }
    this.early.set(e.q, e.d)
    const messages: unknown[] = []
    while (this.early.has(this.nextIn)) {
      messages.push(this.early.get(this.nextIn))
      this.early.delete(this.nextIn)
      this.nextIn++
    }
    return messages.length ? { kind: 'delivered', messages } : { kind: 'buffered' }
  }

  /** Payloads to send again: all unacknowledged (`all`) or those older than `olderThanMs`. */
  due(now: number, olderThanMs: number, all = false): string[] {
    const out: string[] = []
    for (const entry of this.unacked.values()) {
      if (!all && now - entry[1] < olderThanMs) continue
      entry[1] = now
      out.push(entry[0])
    }
    return out
  }
}
