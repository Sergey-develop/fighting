import type { ImpactStyle } from '../fighters/types'

export type ParticleKind = 'pixel' | 'burst' | 'ring' | 'dust' | 'ember' | 'bill' | 'coin' | 'glyph' | 'shock'

/** Pooled particle; world coordinates (y = height above floor). */
export interface Particle {
  active: boolean
  kind: ParticleKind
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  rotation: number
  /** rotation speed (rad/tick) for spinning bills / flipping coins */
  spin: number
  /** -1 / 1: which way gravity-free projectiles drift (unused by most kinds) */
  gravity: number
  color: string
}

const POOL_SIZE = 240

const IMPACT_SETTINGS: Readonly<Record<ImpactStyle, { pixels: number; burst: number; speed: number }>> = {
  light: { pixels: 6, burst: 70, speed: 6 },
  heavy: { pixels: 12, burst: 120, speed: 9 },
  special: { pixels: 18, burst: 170, speed: 11 },
}

/** Palette taken from the UI mock-ups (P1 yellow / P2 pink / white). */
export const PLAYER_COLORS = ['#ffd21f', '#ff2e9a'] as const

/**
 * Small, deliberate effects: hit sparks, comic impact bursts, screen shake
 * and a short full-screen flash for specials. No allocations after init.
 */
export class VfxSystem {
  readonly particles: Particle[] = Array.from({ length: POOL_SIZE }, () => ({
    active: false,
    kind: 'pixel' as ParticleKind,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 1,
    rotation: 0,
    spin: 0,
    gravity: 0,
    color: '#fff',
  }))
  private next = 0
  shake = 0
  private shakeTime = 0
  flashAlpha = 0
  flashColor = '#ffffff'

  private spawn(kind: ParticleKind): Particle | null {
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = this.particles[(this.next + i) % POOL_SIZE]
      if (p && !p.active) {
        this.next = (this.next + i + 1) % POOL_SIZE
        p.active = true
        p.kind = kind
        p.spin = 0
        p.gravity = 0
        return p
      }
    }
    return null
  }

  hit(x: number, y: number, impact: ImpactStyle, color: string, dir: number, shake: number): void {
    const cfg = IMPACT_SETTINGS[impact]
    const burst = this.spawn('burst')
    if (burst) {
      burst.x = x
      burst.y = y
      burst.vx = 0
      burst.vy = 0
      burst.life = burst.maxLife = impact === 'light' ? 9 : 13
      burst.size = cfg.burst
      burst.rotation = Math.random() * Math.PI
      burst.color = impact === 'special' ? color : impact === 'heavy' ? '#ffd21f' : '#ffffff'
    }
    for (let i = 0; i < cfg.pixels; i++) {
      const p = this.spawn('pixel')
      if (!p) break
      const a = (Math.random() - 0.5) * Math.PI * 1.2
      const s = cfg.speed * (0.5 + Math.random() * 0.7)
      p.x = x
      p.y = y
      p.vx = Math.cos(a) * s * dir
      p.vy = Math.sin(a) * s + 3
      p.life = p.maxLife = 16 + Math.floor(Math.random() * 10)
      p.size = 6 + Math.floor(Math.random() * 3) * 2
      p.rotation = 0
      p.color = i % 3 === 0 ? '#ffffff' : impact === 'special' ? color : i % 2 ? PLAYER_COLORS[0] : PLAYER_COLORS[1]
    }
    if (shake > 0) this.addShake(shake, impact === 'special' ? 18 : 10)
    if (impact === 'special') {
      this.flashAlpha = 0.35
      this.flashColor = color
    }
  }

  block(x: number, y: number): void {
    const ring = this.spawn('ring')
    if (ring) {
      ring.x = x
      ring.y = y
      ring.vx = ring.vy = 0
      ring.life = ring.maxLife = 10
      ring.size = 70
      ring.rotation = 0
      ring.color = '#9fe8ff'
    }
    for (let i = 0; i < 5; i++) {
      const p = this.spawn('pixel')
      if (!p) break
      p.x = x
      p.y = y
      p.vx = (Math.random() - 0.5) * 6
      p.vy = Math.random() * 5
      p.life = p.maxLife = 12
      p.size = 6
      p.rotation = 0
      p.color = '#9fe8ff'
    }
  }

  /** Pixel dust puffs kicked up from the floor (jump, landing, sliding). */
  dust(x: number, count: number, dir: number, spread = 1): void {
    for (let i = 0; i < count; i++) {
      const p = this.spawn('dust')
      if (!p) break
      const side = count > 2 ? (i % 2 === 0 ? -1 : 1) : dir
      p.x = x + side * (10 + Math.random() * 30) * spread
      p.y = 4 + Math.random() * 10
      p.vx = side * (1 + Math.random() * 2.5) * spread
      p.vy = 0.4 + Math.random() * 1.2
      p.life = p.maxLife = 18 + Math.floor(Math.random() * 12)
      p.size = 8 + Math.floor(Math.random() * 3) * 4
      p.rotation = 0
      p.color = '#d9cff5'
    }
  }

  /** Rising sparks around a fighter charging a special. */
  ember(x: number, y: number, color: string): void {
    const p = this.spawn('ember')
    if (!p) return
    p.x = x + (Math.random() - 0.5) * 160
    p.y = y + Math.random() * 120
    p.vx = (Math.random() - 0.5) * 0.8
    p.vy = 2.5 + Math.random() * 3
    p.life = p.maxLife = 22 + Math.floor(Math.random() * 14)
    p.size = 4 + Math.floor(Math.random() * 2) * 2
    p.rotation = 0
    p.color = Math.random() < 0.3 ? '#ffffff' : color
  }

  /** A banknote or coin thrown out of a money spray. */
  money(x: number, y: number, dir: number, speed: number, spread: number): void {
    const coin = Math.random() < 0.45
    const p = this.spawn(coin ? 'coin' : 'bill')
    if (!p) return
    const a = (Math.random() - 0.5) * spread
    const s = speed * (0.7 + Math.random() * 0.6)
    p.x = x
    p.y = y + (Math.random() - 0.5) * 20
    p.vx = Math.cos(a) * s * dir
    p.vy = Math.sin(a) * s + 1
    p.life = p.maxLife = 26 + Math.floor(Math.random() * 16)
    p.size = coin ? 14 + Math.floor(Math.random() * 3) * 2 : 30 + Math.floor(Math.random() * 3) * 4
    p.rotation = Math.random() * Math.PI * 2
    p.spin = (Math.random() - 0.5) * 0.5
    p.gravity = 0.12
    p.color = coin ? '#ffcc1e' : '#3fae49'
  }

  /** "0"/"1" code glyphs rising out of a code pillar. */
  glyph(x: number, y: number, color: string): void {
    const p = this.spawn('glyph')
    if (!p) return
    p.x = x
    p.y = y
    p.vx = (Math.random() - 0.5) * 1.5
    p.vy = 3 + Math.random() * 4
    p.life = p.maxLife = 24 + Math.floor(Math.random() * 14)
    p.size = 10 + Math.floor(Math.random() * 3) * 3
    p.rotation = Math.random() < 0.5 ? 0 : 1 // 0 = "0", 1 = "1"
    p.color = color
  }

  /** Expanding glow ring (portal pulses). */
  pulse(x: number, y: number, color: string, size: number): void {
    const p = this.spawn('ring')
    if (!p) return
    p.x = x
    p.y = y
    p.vx = p.vy = 0
    p.life = p.maxLife = 18
    p.size = size
    p.rotation = 0
    p.color = color
  }

  /** Flat shockwave ring on the floor. */
  shock(x: number, color: string, size = 140): void {
    const p = this.spawn('shock')
    if (!p) return
    p.x = x
    p.y = 0
    p.vx = p.vy = 0
    p.life = p.maxLife = 16
    p.size = size
    p.rotation = 0
    p.color = color
  }

  ko(): void {
    this.addShake(16, 24)
    this.flashAlpha = 0.5
    this.flashColor = '#ffffff'
  }

  addShake(amount: number, ticks: number): void {
    if (amount >= this.shake) {
      this.shake = amount
      this.shakeTime = ticks
    }
  }

  /** Call once per simulation tick. */
  update(): void {
    for (const p of this.particles) {
      if (!p.active) continue
      p.life--
      if (p.life <= 0) {
        p.active = false
        continue
      }
      if (p.kind === 'pixel') {
        p.x += p.vx
        p.y += p.vy
        p.vy -= 0.6
        p.vx *= 0.94
      } else if (p.kind === 'dust') {
        p.x += p.vx
        p.y += p.vy
        p.vx *= 0.9
        p.vy *= 0.92
      } else if (p.kind === 'ember' || p.kind === 'glyph') {
        p.x += p.vx
        p.y += p.vy
        p.vy *= 0.97
      } else if (p.kind === 'bill' || p.kind === 'coin') {
        p.x += p.vx
        p.y += p.vy
        p.vx *= 0.985
        p.vy -= p.gravity
        p.rotation += p.spin
      }
    }
    if (this.shakeTime > 0) {
      this.shakeTime--
      this.shake *= 0.86
      if (this.shakeTime === 0) this.shake = 0
    }
    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - 0.04)
  }

  clear(): void {
    for (const p of this.particles) p.active = false
    this.shake = 0
    this.shakeTime = 0
    this.flashAlpha = 0
  }
}
