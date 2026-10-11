/**
 * Link handshake, run on the transport both sides picked:
 *
 *   host  → guest   hello(v)   (host adopted the link)
 *   guest → host    hello(v)   (guest heard the host: host→guest works)
 *   host  → guest   ready      (host heard the guest: both directions work)
 *
 * Only after it the link counts as connected. Duplicates (a resent message)
 * never repeat a transition; a lost reply is answered again.
 */

export type HandshakeMessage = { t: 'hello'; v: number } | { t: 'ready' }

export type HandshakeRole = 'host' | 'guest'

export type HandshakeState = 'linking' | 'connected' | 'failed'

export type HandshakeEvent =
  /** both directions confirmed — happens exactly once */
  | 'connected'
  /** guest: answered the host's hello, waiting for 'ready' */
  | 'answered'
  /** the other side runs a different protocol version */
  | 'version-mismatch'
  /** a repeated handshake message; answered if needed, no state change */
  | 'duplicate'
  /** a message this role never expects (ignored) */
  | 'unexpected'

export class Handshake {
  state: HandshakeState = 'linking'
  private repliedHello = false

  constructor(
    readonly role: HandshakeRole,
    readonly version: number,
    private readonly send: (m: HandshakeMessage) => void,
  ) {}

  /** The link was adopted: the host opens the handshake. */
  begin(): void {
    if (this.role === 'host') this.send({ t: 'hello', v: this.version })
  }

  handle(m: HandshakeMessage): HandshakeEvent {
    if (this.state === 'failed') return 'unexpected'
    if (m.t === 'hello') {
      if (m.v !== this.version) {
        this.state = 'failed'
        return 'version-mismatch'
      }
      if (this.role === 'host') {
        // the guest's hello: confirm (again, if our 'ready' got lost)
        this.send({ t: 'ready' })
        if (this.state === 'connected') return 'duplicate'
        this.state = 'connected'
        return 'connected'
      }
      // guest: answer the host's hello; a repeat means our answer may be lost, answer again
      const repeat = this.repliedHello
      this.repliedHello = true
      this.send({ t: 'hello', v: this.version })
      return repeat ? 'duplicate' : 'answered'
    }
    // 'ready'
    if (this.role === 'host') return 'unexpected'
    if (!this.repliedHello) return 'unexpected' // can't be ready before we said hello
    if (this.state === 'connected') return 'duplicate'
    this.state = 'connected'
    return 'connected'
  }
}
