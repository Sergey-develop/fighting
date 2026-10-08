import type { SpriteAtlas } from '../assets/atlas'
import { COMBAT_CONFIG } from '../core/config'
import { createRect, type Rect } from '../core/types'
import { createSpriteSelection, selectSprite, type SpriteSelection } from '../combat/animation'
import type { AnimationEffect } from '../fighters/types'
import { isAttackState, type Fighter } from '../combat/fighter'
import type { VfxSystem } from '../vfx/vfx'
import { BOLT_COUNT, BOLT_POINTS, GHOST_MAX_LIFE, type FighterFx } from './fighter-fx'

const ARENA = COMBAT_CONFIG.arena

/** overshooting ease for things that pop out (beams, pillars) */
function easeOutBack(x: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}

export interface RenderOptions {
  showHitboxes: boolean
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D
  private background: HTMLCanvasElement | null = null
  private sceneImage: HTMLImageElement | null = null
  private readonly sel: [SpriteSelection, SpriteSelection] = [createSpriteSelection(), createSpriteSelection()]
  private readonly rect: Rect = createRect()
  options: RenderOptions = { showHitboxes: false }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly atlases: readonly [SpriteAtlas, SpriteAtlas],
    /** arena background; null = plain gradient in the mock-ups' palette */
    stageImage: string | null,
  ) {
    canvas.width = ARENA.width
    canvas.height = ARENA.height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas not supported')
    this.ctx = ctx
    ctx.imageSmoothingQuality = 'high'
    if (stageImage) {
      const img = new Image()
      img.onload = () => {
        this.sceneImage = img
        this.background = null
      }
      img.src = stageImage
    }
  }

  // ------------------------------------------------------------ background

  private buildBackground(): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = ARENA.width
    c.height = ARENA.height
    const g = c.getContext('2d')
    if (!g) return c
    const img = this.sceneImage
    if (img) {
      // cover-fit, anchored to the bottom so the floor stays visible
      const s = Math.max(c.width / img.width, c.height / img.height)
      const w = img.width * s
      const h = img.height * s
      g.drawImage(img, (c.width - w) / 2, c.height - h, w, h)
      return c
    }
    const sky = g.createLinearGradient(0, 0, 0, ARENA.floorY)
    sky.addColorStop(0, '#2b2a6b')
    sky.addColorStop(0.45, '#8a4a9c')
    sky.addColorStop(0.75, '#f07a7a')
    sky.addColorStop(1, '#ffb36b')
    g.fillStyle = sky
    g.fillRect(0, 0, c.width, ARENA.floorY)
    const floor = g.createLinearGradient(0, ARENA.floorY, 0, c.height)
    floor.addColorStop(0, '#5b4c9a')
    floor.addColorStop(1, '#2a2350')
    g.fillStyle = floor
    g.fillRect(0, ARENA.floorY, c.width, c.height - ARENA.floorY)
    g.fillStyle = 'rgba(255,255,255,0.18)'
    g.fillRect(0, ARENA.floorY, c.width, 3)
    return c
  }

  // ----------------------------------------------------------------- draw

  /**
   * @param fx    per-fighter procedural animation (squash, lean, trails, aura)
   * @param dim   0..1 darkening of the stage while a special is charging
   */
  render(
    fighters: readonly [Fighter, Fighter],
    vfx: VfxSystem,
    alpha: number,
    fx: readonly [FighterFx, FighterFx],
    dim: number,
  ): void {
    const ctx = this.ctx
    if (!this.background) this.background = this.buildBackground()

    ctx.save()
    if (vfx.shake > 0.5) {
      ctx.translate((Math.random() - 0.5) * vfx.shake * 2, (Math.random() - 0.5) * vfx.shake)
    }
    ctx.drawImage(this.background, 0, 0)
    if (dim > 0.01) {
      // "super flash": the stage darkens while a special charges
      ctx.globalAlpha = dim * 0.5
      ctx.fillStyle = '#07040f'
      ctx.fillRect(-40, -40, ARENA.width + 80, ARENA.height + 80)
      ctx.globalAlpha = 1
    }

    for (const f of fighters) this.drawShadow(f, alpha)
    for (const f of fighters) this.drawGhosts(f, fx[f.slot])
    // attacker on top
    const [a, b] = fighters
    const aFirst = isAttackState(b.state) && !isAttackState(a.state)
    if (aFirst) {
      this.drawFighter(a, alpha, fx[0])
      this.drawFighter(b, alpha, fx[1])
    } else {
      this.drawFighter(b, alpha, fx[1])
      this.drawFighter(a, alpha, fx[0])
    }
    for (const f of fx) this.drawBolts(f)
    this.drawParticles(vfx)
    if (this.options.showHitboxes) for (const f of fighters) this.drawBoxes(f)
    ctx.restore()

    if (vfx.flashAlpha > 0) {
      ctx.globalAlpha = vfx.flashAlpha
      ctx.fillStyle = vfx.flashColor
      ctx.fillRect(0, 0, ARENA.width, ARENA.height)
      ctx.globalAlpha = 1
    }
  }

  private screenX(f: Fighter, alpha: number): number {
    return f.prevX + (f.x - f.prevX) * alpha
  }

  private screenY(f: Fighter, alpha: number): number {
    return ARENA.floorY - (f.prevY + (f.y - f.prevY) * alpha)
  }

  private drawShadow(f: Fighter, alpha: number): void {
    const ctx = this.ctx
    const x = this.screenX(f, alpha)
    const h = f.prevY + (f.y - f.prevY) * alpha
    const s = Math.max(0.35, 1 - h / 600)
    ctx.fillStyle = 'rgba(10,6,30,0.35)'
    ctx.beginPath()
    ctx.ellipse(x, ARENA.floorY + 4, 95 * s, 16 * s, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawFighter(f: Fighter, alpha: number, fx: FighterFx): void {
    const atlas = this.atlases[f.slot]
    const sel = selectSprite(f, this.sel[f.slot])
    const x = this.screenX(f, alpha) + fx.ox
    const y = this.screenY(f, alpha) + fx.oy
    const scale = f.def.spriteScale
    if (fx.aura > 0.02) this.drawAura(x, y, fx)
    if (sel.overlayRow >= 0) {
      this.drawFrame(atlas, f, sel.overlayRow, sel.overlayFrame, x + f.facing * sel.overlayOffsetX, ARENA.floorY - sel.overlayOffsetY, scale, false, f.facing, 1, 1, 0, sel, true)
    }
    this.drawFrame(atlas, f, sel.row, sel.frame, x, y, scale, f.flashFrames > 0 && f.flashFrames % 4 < 2, f.facing, fx.sx, fx.sy, fx.rot, sel, false)
  }

  /** Fading afterimages of recent poses. */
  private drawGhosts(f: Fighter, fx: FighterFx): void {
    const atlas = this.atlases[f.slot]
    const ctx = this.ctx
    for (const g of fx.ghosts) {
      if (g.life <= 0) continue
      ctx.globalAlpha = 0.32 * (g.life / GHOST_MAX_LIFE)
      this.drawFrame(atlas, f, g.sel.row, g.sel.frame, g.x, ARENA.floorY - g.y, f.def.spriteScale, false, g.facing, g.sx, g.sy, g.rot)
    }
    ctx.globalAlpha = 1
  }

  /** Cached soft glow sprites, one per colour (no gradients built per frame). */
  private readonly glows = new Map<string, HTMLCanvasElement>()

  private glowSprite(color: string): HTMLCanvasElement {
    let c = this.glows.get(color)
    if (!c) {
      c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')
      if (g) {
        const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
        grad.addColorStop(0, color)
        grad.addColorStop(0.35, color)
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        g.globalAlpha = 0.9
        g.fillStyle = grad
        g.fillRect(0, 0, 256, 256)
      }
      this.glows.set(color, c)
    }
    return c
  }

  private drawAura(x: number, y: number, fx: FighterFx): void {
    const ctx = this.ctx
    const pulse = 1 + 0.06 * Math.sin(performance.now() * 0.02)
    const w = 430 * pulse
    const h = 560 * pulse
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, fx.aura) * 0.55
    ctx.drawImage(this.glowSprite(fx.auraColor), x - w / 2, y - 200 - h / 2, w, h)
    ctx.restore()
  }

  private drawFrame(
    atlas: SpriteAtlas,
    f: Fighter,
    row: number,
    frame: number,
    x: number,
    y: number,
    scale: number,
    flash: boolean,
    facing: 1 | -1,
    sx: number,
    sy: number,
    rot: number,
    fxSel: SpriteSelection | null = null,
    overlayLayer = false,
  ): void {
    const fr = atlas.rows[row - 1]?.[frame]
    if (!fr) return
    const ctx = this.ctx
    let ax = fr.ax
    let ay = fr.ay
    const overrides = f.def.anchorOverrides
    if (overrides) {
      const ov = overrides[`${row}:${frame}`]
      if (ov) {
        ax += ov.dx
        ay += ov.dy
      }
    }
    ctx.save()
    // pivot at the feet: squash/stretch and lean keep the fighter planted
    ctx.translate(x, y)
    if (rot !== 0) ctx.rotate(rot * facing)
    ctx.scale(facing * scale * sx, scale * sy)
    const effect = fxSel ? (overlayLayer ? fxSel.overlayEffect : fxSel.effect) : null
    if (effect && fxSel) {
      this.drawEffectFrame(atlas, fr, ax, ay, effect, fxSel.effectT, fxSel.effectFade)
    } else {
      ctx.drawImage(atlas.image, fr.x, fr.y, fr.w, fr.h, -ax, -ay, fr.w, fr.h)
    }
    if (flash) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.55
      ctx.drawImage(atlas.image, fr.x, fr.y, fr.w, fr.h, -ax, -ay, fr.w, fr.h)
    }
    ctx.restore()
  }

  /**
   * Draws a frame whose painted effect is animated separately from the body:
   * beams/sprays grow out of the hand and wobble, pillars rise from the floor,
   * portals shimmer, always with an additive glow pass on top.
   * Called inside drawFrame's transform (frame pixels, feet at the origin).
   */
  private drawEffectFrame(
    atlas: SpriteAtlas,
    fr: { x: number; y: number; w: number; h: number },
    ax: number,
    ay: number,
    effect: AnimationEffect,
    t: number,
    fade: number,
  ): void {
    const ctx = this.ctx
    const img = atlas.image
    const baseAlpha = ctx.globalAlpha
    const glow = (0.26 + 0.18 * Math.sin(t * 0.8)) * fade

    if (effect.splitX > 0) {
      const cut = Math.min(fr.w, Math.max(0, Math.round(ax + effect.splitX)))
      if (cut > 0) ctx.drawImage(img, fr.x, fr.y, cut, fr.h, -ax, -ay, cut, fr.h)
      const ew = fr.w - cut
      if (ew > 2 && fade > 0) {
        const grow = easeOutBack(Math.min(1, t / 6))
        const wx = 1 + 0.04 * Math.sin(t * 1.37)
        const wy = 1 + 0.07 * Math.sin(t * 0.93)
        ctx.save()
        // pivot on the hand: the effect stretches out of it and breathes
        ctx.translate(cut - ax, -effect.originY)
        ctx.scale(Math.max(0.05, grow * wx), wy)
        ctx.globalAlpha = baseAlpha * fade
        ctx.drawImage(img, fr.x + cut, fr.y, ew, fr.h, 0, -ay + effect.originY, ew, fr.h)
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = baseAlpha * glow
        ctx.drawImage(img, fr.x + cut, fr.y, ew, fr.h, 0, -ay + effect.originY, ew, fr.h)
        ctx.restore()
      }
      return
    }

    ctx.save()
    if (effect.style === 'codePillar') {
      // erupts from the floor with an overshoot, then sways
      const rise = easeOutBack(Math.min(1, t / 5))
      ctx.scale(1 + 0.05 * Math.sin(t * 1.1), Math.max(0.05, rise))
      ctx.globalAlpha = baseAlpha * fade
    } else {
      // portal: the whole frame shimmers
      ctx.scale(1 + 0.035 * Math.sin(t * 0.45), 1)
    }
    ctx.drawImage(img, fr.x, fr.y, fr.w, fr.h, -ax, -ay, fr.w, fr.h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = baseAlpha * (effect.style === 'portal' ? 0.18 + 0.14 * Math.sin(t * 0.6) : glow)
    ctx.drawImage(img, fr.x, fr.y, fr.w, fr.h, -ax, -ay, fr.w, fr.h)
    ctx.restore()
  }

  /** Procedural lightning layered over a beam special. */
  private drawBolts(fx: FighterFx): void {
    if (fx.boltAlpha <= 0.01) return
    const ctx = this.ctx
    const b = fx.bolts
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineJoin = 'miter'
    for (let k = 0; k < BOLT_COUNT; k++) {
      ctx.beginPath()
      for (let i = 0; i < BOLT_POINTS; i++) {
        const o = (k * BOLT_POINTS + i) * 2
        const px = b[o] ?? 0
        const py = ARENA.floorY - (b[o + 1] ?? 0)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      const a = fx.boltAlpha * (k === 0 ? 1 : 0.7)
      ctx.strokeStyle = fx.boltColor
      ctx.globalAlpha = a * 0.25
      ctx.lineWidth = 16
      ctx.stroke()
      ctx.globalAlpha = a * 0.7
      ctx.lineWidth = 6
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.globalAlpha = a
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawParticles(vfx: VfxSystem): void {
    const ctx = this.ctx
    for (const p of vfx.particles) {
      if (!p.active) continue
      const t = p.life / p.maxLife
      const sx = p.x
      const sy = ARENA.floorY - p.y
      if (p.kind === 'pixel') {
        ctx.globalAlpha = Math.min(1, t * 1.5)
        ctx.fillStyle = p.color
        ctx.fillRect(Math.round(sx - p.size / 2), Math.round(sy - p.size / 2), p.size, p.size)
      } else if (p.kind === 'dust') {
        // chunky pixel puffs that grow and fade
        const size = Math.round(p.size * (1 + (1 - t) * 0.9))
        ctx.globalAlpha = t * 0.55
        ctx.fillStyle = p.color
        ctx.fillRect(Math.round(sx - size / 2), Math.round(sy - size / 2), size, size)
      } else if (p.kind === 'bill') {
        // spinning banknote: green body, dark outline, light band
        ctx.globalAlpha = Math.min(1, t * 2.5)
        ctx.save()
        ctx.translate(sx, sy)
        ctx.rotate(p.rotation)
        const w = p.size
        const h = Math.round(p.size * 0.5)
        ctx.fillStyle = '#0e3b16'
        ctx.fillRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4)
        ctx.fillStyle = p.color
        ctx.fillRect(-w / 2, -h / 2, w, h)
        ctx.fillStyle = '#a6e8a0'
        ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w - 6, 2)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(-2, -h / 2, 4, h)
        ctx.restore()
      } else if (p.kind === 'coin') {
        // flipping coin: its width follows the spin
        ctx.globalAlpha = Math.min(1, t * 2.5)
        const rx = Math.max(1.5, Math.abs(Math.cos(p.rotation)) * p.size * 0.5)
        const ry = p.size * 0.5
        ctx.beginPath()
        ctx.ellipse(sx, sy, rx + 2, ry + 2, 0, 0, Math.PI * 2)
        ctx.fillStyle = '#5a3a00'
        ctx.fill()
        ctx.beginPath()
        ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2)
        ctx.fillStyle = p.color
        ctx.fill()
        ctx.fillStyle = '#fff3a6'
        ctx.fillRect(Math.round(sx - rx * 0.4), Math.round(sy - ry * 0.55), Math.max(1, Math.round(rx * 0.35)), Math.round(ry * 0.5))
      } else if (p.kind === 'glyph') {
        // pixel "0" / "1" rising from the code pillar
        ctx.globalAlpha = Math.min(1, t * 2) * (p.life % 6 < 4 ? 1 : 0.6)
        ctx.strokeStyle = p.color
        ctx.lineWidth = 3
        const gh = p.size
        if (p.rotation === 0) {
          ctx.strokeRect(Math.round(sx - gh * 0.3), Math.round(sy - gh / 2), Math.round(gh * 0.6), gh)
        } else {
          ctx.fillStyle = p.color
          ctx.fillRect(Math.round(sx - 1.5), Math.round(sy - gh / 2), 3, gh)
        }
      } else if (p.kind === 'shock') {
        // flat expanding ring on the floor
        const r = p.size * (0.4 + (1 - t) * 0.9)
        ctx.globalAlpha = t
        ctx.strokeStyle = p.color
        ctx.lineWidth = 6 * t + 1
        ctx.beginPath()
        ctx.ellipse(sx, ARENA.floorY, r, r * 0.22, 0, 0, Math.PI * 2)
        ctx.stroke()
      } else if (p.kind === 'ember') {
        ctx.globalAlpha = (p.life % 4 < 2 ? 1 : 0.6) * Math.min(1, t * 2)
        ctx.fillStyle = p.color
        ctx.fillRect(Math.round(sx - p.size / 2), Math.round(sy - p.size / 2), p.size, p.size)
      } else if (p.kind === 'burst') {
        // comic starburst with a dark outline, like the UI art
        const r = p.size * (0.55 + (1 - t) * 0.6)
        ctx.globalAlpha = Math.min(1, t * 1.8)
        ctx.beginPath()
        const spikes = 10
        for (let i = 0; i <= spikes * 2; i++) {
          const ang = p.rotation + (i * Math.PI) / spikes
          const rr = i % 2 === 0 ? r : r * 0.45
          const px = sx + Math.cos(ang) * rr
          const py = sy + Math.sin(ang) * rr
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.fillStyle = p.color
        ctx.fill()
        ctx.lineWidth = 5
        ctx.strokeStyle = '#120a24'
        ctx.stroke()
      } else {
        ctx.globalAlpha = t
        ctx.lineWidth = 6
        ctx.strokeStyle = p.color
        ctx.beginPath()
        ctx.arc(sx, sy, p.size * (1.2 - t * 0.6), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  private drawBoxes(f: Fighter): void {
    const ctx = this.ctx
    const n = f.computeHurtboxes()
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(80,200,255,0.9)'
    for (let i = 0; i < n; i++) {
      const r = f.hurtRects[i]
      if (r) ctx.strokeRect(r.left, ARENA.floorY - r.top, r.right - r.left, r.top - r.bottom)
    }
    const atk = f.attack
    if (atk && f.attackPhase === 'active') {
      const r = f.boxToRect(atk.hitbox, this.rect)
      ctx.strokeStyle = 'rgba(255,60,60,0.95)'
      ctx.strokeRect(r.left, ARENA.floorY - r.top, r.right - r.left, r.top - r.bottom)
    }
    ctx.fillStyle = '#fff'
    ctx.fillRect(f.x - 3, ARENA.floorY - f.y - 3, 6, 6)
  }
}
