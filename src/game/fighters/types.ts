import type { SoundId } from '../audio/sounds'

/** Button-level attack kinds. The combat system only knows these four. */
export type AttackKind = 'light' | 'heavy' | 'kick' | 'special'
export const ATTACK_KINDS: readonly AttackKind[] = ['light', 'heavy', 'kick', 'special']

/** Concrete attack slot of a fighter: button kind + ground/air variant. */
export type AttackSlot = AttackKind | 'airLight' | 'airHeavy' | 'airKick'

/**
 * Box relative to the fighter's anchor (centre of the feet on the floor).
 * x: forward offset of the box centre (mirrored by facing)
 * y: height of the box bottom above the anchor
 */
export interface BoxDefinition {
  x: number
  y: number
  width: number
  height: number
}

export interface KnockbackDefinition {
  /** horizontal launch speed (px/tick) away from the attacker */
  horizontalForce: number
  /** vertical launch speed (px/tick); > 0 launches the defender into the air */
  verticalForce: number
  /** hitstun duration in ticks */
  duration: number
}

/**
 * blockable  — blocked hits deal chip damage + blockstun
 * guardBreak — ignores block: the defender is hit (reduced damage, extra stun)
 */
export type BlockInteraction = 'blockable' | 'guardBreak'

/**
 * Procedural styles that bring an effect painted into the sprite frames to
 * life (the art itself is never changed). Fighters pick a style; new fighters
 * can reuse them.
 */
export type EffectStyle = 'lightning' | 'money' | 'codePillar' | 'portal'

export interface AnimationEffect {
  style: EffectStyle
  /**
   * Forward distance (atlas px from the anchor) where the effect leaves the
   * body. The part of the frame beyond it grows out of the hand, wobbles and
   * glows on its own. 0 = the effect is the whole frame.
   */
  splitX: number
  /** height of the emitter (hand / portal centre) above the feet, atlas px */
  originY: number
  color: string
}

/** Indices refer to frames inside one row of the fighter's sprite atlas. */
export interface LoopAnimation {
  row: number
  frames: readonly number[]
  ticksPerFrame: number
  loop: boolean
  effect?: AnimationEffect
}

/** Optional second sprite layer drawn at an offset (e.g. a pillar at the target). */
export interface OverlayAnimation {
  row: number
  active: readonly number[]
  recovery: readonly number[]
  /** forward offset of the overlay's anchor from the fighter's anchor */
  offsetX: number
  offsetY: number
  effect?: AnimationEffect
}

/**
 * Attack animation frames are stretched over the attack's phases, so the
 * visuals always line up with startup/active/recovery frame data.
 */
export interface AttackAnimation {
  row: number
  startup: readonly number[]
  active: readonly number[]
  recovery: readonly number[]
  overlay?: OverlayAnimation
  /** baked-in effect shown from the active phase on (beam, spray...) */
  effect?: AnimationEffect
}

export type ImpactStyle = 'light' | 'heavy' | 'special'

export interface AttackDefinition {
  id: string
  /** shown on combo finishers / move lists */
  name: string
  kind: AttackKind
  damage: number
  startupFrames: number
  activeFrames: number
  recoveryFrames: number
  hitbox: BoxDefinition
  knockback: KnockbackDefinition
  blockInteraction: BlockInteraction
  /** blockstun inflicted when blocked (ticks) */
  blockstun: number
  /** freeze frames for both fighters on contact */
  hitstop: number
  /** energy needed to start the attack */
  energyCost?: number
  /** overrides COMBAT_CONFIG.energy.energyGainOnHit */
  energyGain?: number
  /** attack kinds this attack can be cancelled into after it connected */
  cancelInto?: readonly AttackKind[]
  /** forward velocity applied during startup (px/tick) */
  lunge?: number
  /** screen shake amplitude on hit (px) */
  screenShake?: number
  impact: ImpactStyle
  /** tint for impact VFX; defaults to white */
  vfxColor?: string
  sound: SoundId
  hitSound: SoundId
  animation: AttackAnimation
}

/** Special attacks always cost energy and carry their own visual identity. */
export interface SpecialDefinition extends AttackDefinition {
  kind: 'special'
  energyCost: number
  /** tint used by the special's VFX (matches the art of the special) */
  vfxColor: string
}

export interface ComboDefinition {
  id: string
  name: string
  /** button sequence, e.g. ['light', 'light', 'kick'] */
  sequence: readonly AttackKind[]
  /** max ticks between the starts of two consecutive attacks */
  maxGapFrames: number
  /** applied to the final attack of the sequence */
  damageMultiplier: number
  knockback?: KnockbackDefinition
  energyBonus?: number
}

export interface FighterStats {
  maxHp: number
  walkSpeed: number
  backWalkSpeed: number
  jumpVelocity: number
  jumpForwardSpeed: number
  /** multiplies received knockback */
  weight: number
}

export interface FighterAnimations {
  idle: LoopAnimation
  walk: LoopAnimation
  jumpSquat: LoopAnimation
  jump: LoopAnimation
  fall: LoopAnimation
  land: LoopAnimation
  hit: LoopAnimation
  /** there is no dedicated block art in the sheets — fighters map it onto an existing pose */
  block: LoopAnimation
  stun: LoopAnimation
  ko: LoopAnimation
  win: LoopAnimation
  intro?: LoopAnimation
}

export interface FighterHurtboxes {
  standing: readonly BoxDefinition[]
  airborne: readonly BoxDefinition[]
  /** used while lying on the ground after KO (no hits are processed then, kept for debug) */
  down: readonly BoxDefinition[]
}

export interface FighterProfileText {
  archetype: string
  speed: string
  health: string
}

export interface FighterDefinition {
  id: string
  name: string
  profile: FighterProfileText
  /** folder under public/assets/fighters/ produced by tools/slice_sprites.py */
  assetDir: string
  /** index of the portrait images (row 0 of the sheet) for different HUD moods */
  portraits: { normal: number; hurt: number; ko: number; select: number }
  /** runtime scale applied to atlas frames */
  spriteScale: number
  stats: FighterStats
  hurtboxes: FighterHurtboxes
  animations: FighterAnimations
  attacks: {
    light: AttackDefinition
    heavy: AttackDefinition
    kick: AttackDefinition
    airLight: AttackDefinition
    airHeavy: AttackDefinition
    airKick: AttackDefinition
  }
  special: SpecialDefinition
  combos: readonly ComboDefinition[]
  /** per-frame anchor correction in atlas px, key "row:frame" */
  anchorOverrides?: Readonly<Record<string, { dx: number; dy: number }>>
}
