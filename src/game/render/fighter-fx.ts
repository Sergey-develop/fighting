import { createSpriteSelection, selectSprite, type SpriteSelection } from '../combat/animation'
import { isAttackState, type Fighter } from '../combat/fighter'
import type { VfxSystem } from '../vfx/vfx'

/** One afterimage of the fighter's pose. */
export interface Ghost {
  life: number
  x: number
  y: number
  facing: 1 | -1
  sx: number
  sy: number
  rot: number
  sel: SpriteSelection
}

const TRAIL_SIZE = 6
const GHOST_LIFE = 10

/** procedural lightning: a few jagged bolts regenerated every other tick */
export const BOLT_COUNT = 3
export const BOLT_POINTS = 16
const BOLT_AMPLITUDE = [44, 30, 20] as const
const PORTAL_COLORS = ['#5ad8ff', '#b46bff', '#3dffa8', '#ffffff'] as const
const GLYPH_COLORS = ['#ff4fd8', '#3dffa8', '#9fe8ff'] as const

/**
 * Procedural "juice" layered on top of the sprite frames — the art is not
 * changed, only how it is placed: squash & stretch, leaning, hit shake,
 * afterimages, dust and a charge aura. Updated once per simulation tick.
 */
export class FighterFx {
  /** scale multipliers around the feet */
  sx = 1
  sy = 1
  /** rotation in the fighter's facing space (+ = lean forward), radians */
  rot = 0
  /** screen offsets (px) — bob and hit shake */
  ox = 0
  oy = 0
  /** 0..1 strength of the glow behind the fighter */
  aura = 0
  auraColor = '#ffffff'

  /** world-space polyline points (x, y) of the lightning bolts */
  readonly bolts = new Float32Array(BOLT_COUNT * BOLT_POINTS * 2)
  /** 0..1 visibility of the bolts (0 = none) */
  boltAlpha = 0
  boltColor = '#5ad8ff'
  private readonly sel = createSpriteSelection()

  readonly ghosts: Ghost[] = Array.from({ length: TRAIL_SIZE }, () => ({
    life: 0,
    x: 0,
    y: 0,
    facing: 1 as 1 | -1,
    sx: 1,
    sy: 1,
    rot: 0,
    sel: createSpriteSelection(),
  }))
  private ghostHead = 0
  private wasAirborne = false
  private tick = 0

  reset(): void {
    this.sx = this.sy = 1
    this.rot = this.ox = this.oy = 0
    this.aura = 0
    this.boltAlpha = 0
    for (const g of this.ghosts) g.life = 0
    this.wasAirborne = false
  }

  private makeBolts(x0: number, y0: number, dir: number, len: number): void {
    const b = this.bolts
    for (let k = 0; k < BOLT_COUNT; k++) {
      const amp = BOLT_AMPLITUDE[k] ?? 20
      let y = y0
      for (let i = 0; i < BOLT_POINTS; i++) {
        const u = i / (BOLT_POINTS - 1)
        // jagged random walk that stays anchored at the hand and narrows at the tip
        y += (Math.random() - 0.5) * amp
        const pull = Math.sin(Math.PI * Math.min(1, u * 1.15))
        const yy = y0 + (y - y0) * pull
        const o = (k * BOLT_POINTS + i) * 2
        b[o] = x0 + dir * len * u
        b[o + 1] = i === 0 ? y0 : yy
      }
    }
  }

  /** Spawns / updates the procedural layer of the fighter's baked-in effects. */
  private animateEffects(f: Fighter, vfx: VfxSystem, t: number): void {
    const sel = selectSprite(f, this.sel)
    const scale = f.def.spriteScale
    this.boltAlpha = 0

    // charge-up swirl of the money spray (before the spray itself appears)
    const charging = f.attack?.animation.effect
    if (charging?.style === 'money' && f.attackPhase === 'startup' && t % 3 === 0) {
      vfx.money(f.x + f.facing * 60, f.y + charging.originY * scale, f.facing, 3, Math.PI * 2)
    }

    const e = sel.effect
    if (e && sel.effectFade > 0) {
      const hx = f.x + f.facing * e.splitX * scale
      const hy = f.y + e.originY * scale
      switch (e.style) {
        case 'lightning': {
          const atk = f.attack
          const reach = atk ? atk.hitbox.x + atk.hitbox.width / 2 - e.splitX * scale : 600
          this.boltAlpha = sel.effectFade
          this.boltColor = e.color
          if (t % 2 === 0) this.makeBolts(hx, hy, f.facing, reach)
          if (t % 2 === 0) vfx.ember(hx + f.facing * Math.random() * reach, hy - 60, Math.random() < 0.5 ? e.color : '#ffe23a')
          break
        }
        case 'money': {
          const n = sel.effectFade >= 1 ? 2 : t % 3 === 0 ? 1 : 0
          for (let i = 0; i < n; i++) vfx.money(hx, hy, f.facing, 15, 0.9)
          break
        }
        case 'portal': {
          if (t % 2 === 0) {
            vfx.ember(f.x, f.y + 40 + Math.random() * 200, PORTAL_COLORS[t % PORTAL_COLORS.length] ?? e.color)
          }
          if (sel.effectT % 22 === 0) vfx.pulse(f.x, hy, e.color, 120)
          break
        }
        case 'codePillar':
          break
      }
    }

    // code pillar overlay: shockwave when it erupts, glyphs while it stands
    const oe = sel.overlayEffect
    if (oe && sel.overlayRow >= 0 && sel.effectFade > 0) {
      const px = f.x + f.facing * sel.overlayOffsetX
      if (sel.effectT === 0) {
        vfx.shock(px, oe.color, 190)
        vfx.dust(px, 8, 0, 1.4)
      }
      if (t % 2 === 0) {
        vfx.glyph(px + (Math.random() - 0.5) * 130, 20 + Math.random() * 120, GLYPH_COLORS[t % GLYPH_COLORS.length] ?? oe.color)
      }
    }
  }

  update(f: Fighter, vfx: VfxSystem): void {
    this.tick++
    const t = this.tick
    for (const g of this.ghosts) if (g.life > 0) g.life--
    this.animateEffects(f, vfx, t)

    // ---------------------------------------------------- take-off / landing
    if (f.airborne && !this.wasAirborne) {
      this.sx = 0.86
      this.sy = 1.16
      vfx.dust(f.x, 6, 0)
    } else if (!f.airborne && this.wasAirborne) {
      this.sx = 1.16
      this.sy = 0.82
      vfx.dust(f.x, 10, 0, 1.3)
    }
    this.wasAirborne = f.airborne

    // ------------------------------------------------- pose targets per state
    let tsx = 1
    let tsy = 1
    let trot = 0
    let toy = 0
    let auraTarget = 0
    const atk = f.attack
    switch (f.state) {
      case 'IDLE':
      case 'INTRO':
      case 'BLOCK': {
        const b = Math.sin(t * 0.085 + f.slot * 1.7)
        tsy = 1 + 0.016 * b
        tsx = 1 - 0.008 * b
        break
      }
      case 'WIN': {
        const b = Math.sin(t * 0.14)
        tsy = 1 + 0.025 * b
        tsx = 1 - 0.012 * b
        break
      }
      case 'WALK': {
        const phase = f.stateFrame * 0.4
        const step = Math.abs(Math.sin(phase))
        toy = -step * 7
        tsy = 1 + 0.025 * step
        tsx = 1 - 0.012 * step
        trot = f.walkDir === f.facing ? 0.04 : -0.03
        break
      }
      case 'JUMP_SQUAT':
        tsx = 1.1
        tsy = 0.86
        break
      case 'JUMP':
        tsx = 0.95
        tsy = 1.06
        trot = f.vx * f.facing > 1 ? 0.06 : 0
        break
      case 'FALL':
        trot = f.vx * f.facing > 1 ? 0.03 : 0
        break
      case 'LAND':
        tsx = 1.05
        tsy = 0.93
        break
      case 'LIGHT_ATTACK':
      case 'KICK':
      case 'HEAVY_ATTACK':
      case 'SPECIAL': {
        const phase = f.attackPhase
        const strong = f.state === 'HEAVY_ATTACK' || f.state === 'SPECIAL'
        if (phase === 'startup') {
          // anticipation: wind up backwards
          trot = strong ? -0.07 : -0.04
          tsx = 0.97
          tsy = 1.03
        } else if (phase === 'active') {
          trot = strong ? 0.08 : 0.05
          tsx = strong ? 1.07 : 1.04
          tsy = strong ? 0.96 : 0.98
        }
        if (atk && strong && phase !== 'recovery' && phase !== 'done') {
          auraTarget = phase === 'startup' ? 0.6 + 0.4 * Math.sin(t * 0.6) : 1
          this.auraColor = atk.vfxColor ?? '#ffd21f'
          if (f.state === 'SPECIAL' && t % 2 === 0) vfx.ember(f.x, f.y + 40, this.auraColor)
          if (f.state === 'HEAVY_ATTACK') auraTarget *= 0.5
        }
        break
      }
      case 'HIT':
        trot = -0.13
        tsx = 0.96
        tsy = 1.03
        // sliding back along the floor kicks up dust
        if (!f.airborne && Math.abs(f.vx) > 3 && t % 3 === 0) vfx.dust(f.x - Math.sign(f.vx) * 30, 2, -Math.sign(f.vx))
        break
      case 'BLOCK_STUN':
        trot = -0.05
        tsx = 0.98
        break
      case 'KO':
        trot = f.airborne ? -0.25 : 0
        if (!f.airborne && Math.abs(f.vx) > 2 && t % 3 === 0) vfx.dust(f.x, 2, -Math.sign(f.vx))
        break
    }

    // springy smoothing toward the targets (impulses above overshoot naturally)
    const k = 0.28
    this.sx += (tsx - this.sx) * k
    this.sy += (tsy - this.sy) * k
    this.rot += (trot - this.rot) * k
    this.oy += (toy - this.oy) * 0.5
    this.aura += (auraTarget - this.aura) * 0.25

    // hit shake while frozen in hitstop
    const shaken = f.hitstop > 0 && (f.state === 'HIT' || f.state === 'BLOCK_STUN' || f.state === 'KO')
    this.ox = shaken ? (t % 2 === 0 ? 5 : -5) : 0

    // ------------------------------------------------------------- afterimages
    const fast =
      (isAttackState(f.state) && (f.state === 'HEAVY_ATTACK' || f.state === 'SPECIAL') && f.attackPhase === 'active') ||
      (f.airborne && (Math.abs(f.vx) > 6 || Math.abs(f.vy) > 12)) ||
      (f.state === 'HIT' && Math.abs(f.vx) > 7) ||
      (f.state === 'KO' && f.airborne)
    if (fast && t % 2 === 0) {
      const g = this.ghosts[this.ghostHead]
      if (g) {
        g.life = GHOST_LIFE
        g.x = f.x
        g.y = f.y
        g.facing = f.facing
        g.sx = this.sx
        g.sy = this.sy
        g.rot = this.rot
        selectSprite(f, g.sel)
        // afterimages show only the body, without overlays or effects
        g.sel.overlayRow = -1
        g.sel.effect = null
      }
      this.ghostHead = (this.ghostHead + 1) % TRAIL_SIZE
    }
  }
}

export const GHOST_MAX_LIFE = GHOST_LIFE
