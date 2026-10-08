import { COMBAT_CONFIG } from '../core/config'
import type { EventQueue } from '../core/events'
import { ACTION_BIT, type InputFrame } from '../input/actions'
import type { AttackDefinition, AttackKind, AttackSlot } from '../fighters/types'
import { comboContinuesWith, findComboFinisher } from './combos'
import { ATTACK_STATE, type Fighter, isGroundActionable } from './fighter'

const { combo: COMBO, physics: PHYS } = COMBAT_CONFIG

/** Priority when several attack buttons go down on the same tick. */
const ATTACK_PRIORITY: readonly AttackKind[] = ['special', 'heavy', 'kick', 'light']

function pressedAttack(input: InputFrame): AttackKind | null {
  for (const k of ATTACK_PRIORITY) if (input.pressed & ACTION_BIT[k]) return k
  return null
}

function horizontal(input: InputFrame): -1 | 0 | 1 {
  const l = (input.held & ACTION_BIT.left) !== 0
  const r = (input.held & ACTION_BIT.right) !== 0
  return l === r ? 0 : l ? -1 : 1
}

export function resolveAttack(f: Fighter, kind: AttackKind, airborne: boolean): { slot: AttackSlot; def: AttackDefinition } | null {
  const atk = f.def.attacks
  if (airborne) {
    switch (kind) {
      case 'light':
        return { slot: 'airLight', def: atk.airLight }
      case 'kick':
        return { slot: 'airKick', def: atk.airKick }
      case 'heavy':
        return { slot: 'airHeavy', def: atk.airHeavy }
      case 'special':
        return null // specials are ground-only
    }
  }
  if (kind === 'special') return { slot: 'special', def: f.def.special }
  return { slot: kind, def: atk[kind] }
}

/**
 * Starts an attack if allowed (energy etc). Returns true on success.
 * `isCancel` links it into the current chain instead of starting a new one.
 */
export function startAttack(f: Fighter, kind: AttackKind, tick: number, events: EventQueue, isCancel: boolean): boolean {
  const resolved = resolveAttack(f, kind, f.airborne)
  if (!resolved) return false
  const { slot, def } = resolved
  const cost = def.energyCost ?? 0
  if (f.energy < cost) {
    events.push('energyDenied', f.slot)
    return false
  }
  f.energy -= cost

  if (f.airborne) {
    // air attacks never take part in combos
    f.airAttacksUsed++
    f.clearHistory()
    f.attackCombo = null
    f.chainLength = 0
  } else {
    f.attackCombo = findComboFinisher(f, kind, tick)
    f.chainLength = isCancel ? f.chainLength + 1 : 1
  }
  f.state = ATTACK_STATE[kind]
  f.stateFrame = 0
  f.attack = def
  f.attackSlot = slot
  f.attackConnected = false
  f.attackHitDone = false
  if (!f.airborne) {
    f.pushHistory(kind, tick)
    f.vx = 0
  }
  f.bufferedAttack = null
  f.bufferedAttackTick = -1

  const e = events.push('attack', f.slot)
  if (e) {
    e.sound = def.sound
    e.text = def.name
  }
  return true
}

function canCancelInto(f: Fighter, kind: AttackKind, tick: number): boolean {
  const atk = f.attack
  if (!atk || f.airborne || !f.attackConnected) return false
  if (f.chainLength >= COMBO.maxChainLength) return false
  if (f.attackPhase === 'startup') return false
  if (atk.cancelInto?.includes(kind)) return true
  return comboContinuesWith(f, kind, tick)
}

/**
 * Applies one tick of player intent to the fighter's state machine.
 * Called for fighters that are not frozen in hitstop.
 */
export function applyInput(f: Fighter, input: InputFrame, tick: number, events: EventQueue): void {
  const atk = pressedAttack(input)
  if (atk) {
    f.bufferedAttack = atk
    f.bufferedAttackTick = tick
  }
  if (input.pressed & ACTION_BIT.jump) f.bufferedJumpTick = tick
  if (f.bufferedAttack && tick - f.bufferedAttackTick > COMBO.inputBufferFrames) f.bufferedAttack = null
  if (f.bufferedJumpTick >= 0 && tick - f.bufferedJumpTick > COMBO.inputBufferFrames) f.bufferedJumpTick = -1

  const dir = horizontal(input)
  const blockHeld = (input.held & ACTION_BIT.block) !== 0
  const s = f.state

  if (s === 'LIGHT_ATTACK' || s === 'HEAVY_ATTACK' || s === 'KICK' || s === 'SPECIAL') {
    if (f.bufferedAttack && canCancelInto(f, f.bufferedAttack, tick)) {
      startAttack(f, f.bufferedAttack, tick, events, true)
    }
    return
  }

  if (s === 'JUMP' || s === 'FALL') {
    if (f.bufferedAttack && f.airAttacksUsed < COMBAT_CONFIG.airAttacksPerJump) {
      if (startAttack(f, f.bufferedAttack, tick, events, false)) return
      f.bufferedAttack = null
    }
    return
  }

  if (s === 'LAND' && f.stateFrame < PHYS.landingFrames) return

  if (isGroundActionable(s) || s === 'LAND') {
    if (f.bufferedAttack) {
      if (startAttack(f, f.bufferedAttack, tick, events, false)) return
      f.bufferedAttack = null
    }
    if (f.bufferedJumpTick >= 0) {
      f.bufferedJumpTick = -1
      f.walkDir = dir
      f.vx = 0
      f.setState('JUMP_SQUAT')
      return
    }
    if (blockHeld) {
      if (s !== 'BLOCK') f.setState('BLOCK')
      f.vx = 0
      return
    }
    if (dir !== 0) {
      if (s !== 'WALK' || f.walkDir !== dir) {
        f.setState('WALK')
        f.walkDir = dir
      }
      const forward = dir === f.facing
      f.vx = dir * (forward ? f.def.stats.walkSpeed : f.def.stats.backWalkSpeed)
      return
    }
    if (s !== 'IDLE') f.setState('IDLE')
    f.vx = 0
    return
  }

  if (s === 'JUMP_SQUAT') {
    // direction can still be chosen during the squat
    if (dir !== 0) f.walkDir = dir
  }
}
