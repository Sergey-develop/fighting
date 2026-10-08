/**
 * Global, fighter-independent tuning. Everything that a designer may want to
 * tweak lives here or in the fighter definitions — never inline in systems.
 * All durations are in simulation ticks (TICK_RATE per second).
 */

export const TICK_RATE = 60
export const TICK_MS = 1000 / TICK_RATE

export interface ArenaConfig {
  /** logical stage size in px; the canvas renders at this resolution */
  width: number
  height: number
  /** screen y of the floor line */
  floorY: number
  /** fighters' anchor x is clamped to [leftBound, rightBound] */
  leftBound: number
  rightBound: number
  /** start positions */
  spawnX: readonly [number, number]
}

export interface PhysicsConfig {
  gravity: number
  groundFriction: number
  airFriction: number
  /** frames between pressing jump and leaving the ground */
  jumpSquatFrames: number
  landingFrames: number
}

export interface BlockConfig {
  /** fraction of damage a normal (blockable) attack still deals when blocked */
  chipDamageScale: number
  /** fraction of damage a guard-breaking attack deals through block */
  guardBreakDamageScale: number
  /** extra hitstun added on guard break (on top of the attack's knockback duration) */
  guardBreakStunFrames: number
  /** horizontal pushback on the defender when blocking, as a fraction of knockback */
  pushbackScale: number
  /** minimum blockstun frames */
  minBlockstunFrames: number
}

export interface EnergyConfig {
  max: number
  startValue: number
  /** passive regeneration per second */
  regenerationPerSecond: number
  /** gained by the attacker per landed hit (attacks may override) */
  energyGainOnHit: number
  /** gained by the attacker when the hit is blocked */
  energyGainOnBlocked: number
  /** gained by the defender per point of damage taken */
  energyGainOnDamage: number
  /** gained by the defender per blocked hit */
  energyGainOnBlock: number
}

export interface ComboConfig {
  /** how long a pressed attack button is remembered while the fighter is busy */
  inputBufferFrames: number
  /** max number of attacks linked into one chain via cancels */
  maxChainLength: number
  /** how long the "COMBO xN" HUD readout stays after the combo ends */
  displayFrames: number
}

export interface RoundConfig {
  roundsToWin: number
  roundTimeSeconds: number
  readyFrames: number
  fightTextFrames: number
  koFreezeFrames: number
  /** slow motion multiplier during the KO freeze */
  koTimeScale: number
  roundEndFrames: number
}

export interface CombatConfig {
  arena: ArenaConfig
  physics: PhysicsConfig
  block: BlockConfig
  energy: EnergyConfig
  combo: ComboConfig
  rounds: RoundConfig
  /** airborne fighters that were hit cannot be hit again until they land (no air combos / juggles) */
  juggleProtection: boolean
  /** each jump allows at most this many air attacks (no air combos) */
  airAttacksPerJump: number
}

export const COMBAT_CONFIG: CombatConfig = {
  arena: {
    width: 1920,
    height: 1080,
    floorY: 965,
    leftBound: 150,
    rightBound: 1770,
    spawnX: [640, 1280],
  },
  physics: {
    gravity: 1.15,
    groundFriction: 0.9,
    airFriction: 0.99,
    jumpSquatFrames: 4,
    landingFrames: 5,
  },
  block: {
    chipDamageScale: 0.15,
    guardBreakDamageScale: 0.8,
    guardBreakStunFrames: 10,
    pushbackScale: 0.8,
    minBlockstunFrames: 8,
  },
  energy: {
    max: 100,
    startValue: 0,
    regenerationPerSecond: 1.2,
    energyGainOnHit: 6,
    energyGainOnBlocked: 2,
    energyGainOnDamage: 0.08,
    energyGainOnBlock: 1,
  },
  combo: {
    inputBufferFrames: 8,
    maxChainLength: 4,
    displayFrames: 90,
  },
  rounds: {
    roundsToWin: 2,
    roundTimeSeconds: 60,
    readyFrames: 100,
    fightTextFrames: 45,
    koFreezeFrames: 70,
    koTimeScale: 0.35,
    roundEndFrames: 150,
  },
  juggleProtection: true,
  airAttacksPerJump: 1,
}
