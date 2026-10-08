import type { AnimationEffect, LoopAnimation } from '../fighters/types'
import type { Fighter } from './fighter'

/** Sprite to draw for a fighter this frame. Reused object — copy if kept. */
export interface SpriteSelection {
  row: number
  frame: number
  /** -1 when there is no overlay */
  overlayRow: number
  overlayFrame: number
  overlayOffsetX: number
  overlayOffsetY: number
  /** baked-in effect of the main frame (null = none) */
  effect: AnimationEffect | null
  /** effect of the overlay frame (null = none) */
  overlayEffect: AnimationEffect | null
  /** ticks since the effect appeared */
  effectT: number
  /** 1 while the effect is fully on, fading to 0 during recovery */
  effectFade: number
}

export function createSpriteSelection(): SpriteSelection {
  return {
    row: 1,
    frame: 0,
    overlayRow: -1,
    overlayFrame: 0,
    overlayOffsetX: 0,
    overlayOffsetY: 0,
    effect: null,
    overlayEffect: null,
    effectT: 0,
    effectFade: 1,
  }
}

function loopFrame(a: LoopAnimation, t: number, reverse = false): number {
  const n = a.frames.length
  let i = Math.floor(t / a.ticksPerFrame)
  i = a.loop ? i % n : Math.min(i, n - 1)
  if (reverse) i = n - 1 - i
  return a.frames[i] ?? a.frames[0] ?? 0
}

/** Spreads `frames` evenly over a phase of `length` ticks. */
function phaseFrame(frames: readonly number[], t: number, length: number): number {
  if (frames.length === 0) return 0
  const i = Math.min(frames.length - 1, Math.floor((t / Math.max(1, length)) * frames.length))
  return frames[i] ?? 0
}

/** Maps the fighter's state machine onto atlas frames. */
export function selectSprite(f: Fighter, out: SpriteSelection): SpriteSelection {
  const anims = f.def.animations
  const t = f.stateFrame
  out.overlayRow = -1
  out.effect = null
  out.overlayEffect = null
  out.effectT = 0
  out.effectFade = 1
  let anim: LoopAnimation = anims.idle
  let reverse = false

  const atk = f.attack
  if (atk) {
    const a = atk.animation
    out.row = a.row
    const s = atk.startupFrames
    const ac = atk.activeFrames
    const r = atk.recoveryFrames
    if (t < s) out.frame = phaseFrame(a.startup, t, s)
    else if (t < s + ac) out.frame = phaseFrame(a.active, t - s, ac)
    else out.frame = phaseFrame(a.recovery, t - s - ac, r)
    if (t >= s) {
      out.effectT = t - s
      out.effectFade = t < s + ac ? 1 : Math.max(0, 1 - (t - s - ac) / Math.max(1, r * 0.6))
      out.effect = a.effect ?? null
    }
    const o = a.overlay
    if (o && t >= s) {
      out.overlayRow = o.row
      out.overlayFrame = t < s + ac ? phaseFrame(o.active, t - s, ac) : phaseFrame(o.recovery, t - s - ac, r)
      out.overlayOffsetX = o.offsetX
      out.overlayOffsetY = o.offsetY
      out.overlayEffect = o.effect ?? null
    }
    return out
  }

  switch (f.state) {
    case 'INTRO':
      anim = anims.intro ?? anims.idle
      break
    case 'IDLE':
      anim = anims.idle
      break
    case 'WALK':
      anim = anims.walk
      reverse = f.walkDir !== f.facing
      break
    case 'JUMP_SQUAT':
      anim = anims.jumpSquat
      break
    case 'JUMP':
      anim = anims.jump
      break
    case 'FALL':
      anim = anims.fall
      break
    case 'LAND':
      anim = anims.land
      break
    case 'BLOCK':
    case 'BLOCK_STUN':
      anim = anims.block
      break
    case 'HIT':
      // long stuns (guard break, specials) show the dizzy animation once the impact pose played
      anim = f.stunFrames > 20 && t > 12 && !f.airborne ? anims.stun : anims.hit
      break
    case 'KO':
      anim = anims.ko
      break
    case 'WIN':
      anim = anims.win
      break
    default:
      anim = anims.idle
  }
  out.row = anim.row
  out.frame = loopFrame(anim, t, reverse)
  if (anim.effect) {
    out.effect = anim.effect
    out.effectT = t
  }
  return out
}
