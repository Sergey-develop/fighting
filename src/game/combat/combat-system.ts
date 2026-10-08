import { COMBAT_CONFIG, TICK_RATE } from '../core/config'
import type { EventQueue } from '../core/events'
import { clamp, rectsOverlap, type Facing } from '../core/types'
import type { InputFrame } from '../input/actions'
import { applyInput } from './controller'
import { type Fighter, isAttackState, isGroundActionable } from './fighter'

const { physics: PHYS, block: BLOCK, energy: ENERGY, combo: COMBO, arena: ARENA } = COMBAT_CONFIG

/**
 * Shared combat rules for every fighter. Knows nothing about devices, AI or
 * which character is fighting — only Fighter state + FighterDefinition data.
 *
 * Tick order: hitstop → input/state machine → state timers → physics →
 * orientation → hit detection → energy & combo bookkeeping.
 */
export class CombatSystem {
  /** when false, inputs are ignored (READY, KO, time over...) */
  controlEnabled = false
  private readonly contact = { x: 0, y: 0 }

  constructor(
    readonly fighters: readonly [Fighter, Fighter],
    private readonly events: EventQueue,
  ) {}

  step(inputs: readonly [InputFrame, InputFrame], tick: number): void {
    const [a, b] = this.fighters
    const frozenA = a.hitstop > 0
    const frozenB = b.hitstop > 0
    if (frozenA) a.hitstop--
    if (frozenB) b.hitstop--

    for (const f of this.fighters) {
      const frozen = f === a ? frozenA : frozenB
      if (frozen) continue
      f.prevX = f.x
      f.prevY = f.y
      if (this.controlEnabled) applyInput(f, inputs[f.slot], tick, this.events)
      else if (isGroundActionable(f.state) && !f.isKO) {
        f.vx = 0
        if (f.state !== 'IDLE') f.setState('IDLE')
      }
      this.advanceState(f)
      this.integrate(f)
    }
    this.updateFacing(a, b, frozenA)
    this.updateFacing(b, a, frozenB)

    if (!frozenA) this.checkHit(a, b, tick)
    if (!frozenB) this.checkHit(b, a, tick)

    this.bookkeeping(a, b, frozenA)
    this.bookkeeping(b, a, frozenB)
  }

  // --------------------------------------------------------------- states

  private advanceState(f: Fighter): void {
    f.stateFrame++
    if (f.flashFrames > 0) f.flashFrames--
    switch (f.state) {
      case 'JUMP_SQUAT':
        if (f.stateFrame >= PHYS.jumpSquatFrames) {
          f.vy = f.def.stats.jumpVelocity
          f.vx = f.walkDir * f.def.stats.jumpForwardSpeed
          f.airborne = true
          f.airAttacksUsed = 0
          f.setState('JUMP')
          this.events.push('jump', f.slot)
        }
        break
      case 'JUMP':
        if (f.vy <= 0) f.setState('FALL')
        break
      case 'LAND':
        if (f.stateFrame >= PHYS.landingFrames && !this.controlEnabled) f.setState('IDLE')
        break
      case 'HIT':
      case 'BLOCK_STUN':
        if (f.stunFrames > 0) f.stunFrames--
        if (f.stunFrames <= 0 && !f.airborne) f.setState('IDLE')
        break
      case 'LIGHT_ATTACK':
      case 'HEAVY_ATTACK':
      case 'KICK':
      case 'SPECIAL': {
        const atk = f.attack
        if (!atk) {
          f.setState(f.airborne ? 'FALL' : 'IDLE')
          break
        }
        if (f.attackPhase === 'startup' && atk.lunge && !f.airborne) f.vx = f.facing * atk.lunge
        if (f.attackPhase === 'done') {
          f.chainLength = 0
          f.setState(f.airborne ? 'FALL' : 'IDLE')
        }
        break
      }
      default:
        break
    }
  }

  // -------------------------------------------------------------- physics

  private integrate(f: Fighter): void {
    if (f.airborne) {
      f.vy -= PHYS.gravity
      f.vx *= PHYS.airFriction
    } else if (f.state !== 'WALK') {
      f.vx *= PHYS.groundFriction
      if (Math.abs(f.vx) < 0.05) f.vx = 0
    }
    f.x += f.vx
    f.y += f.vy

    if (f.airborne && f.y <= 0 && f.vy <= 0) {
      f.y = 0
      f.vy = 0
      f.airborne = false
      this.onLand(f)
    }
    const bounded = clamp(f.x, ARENA.leftBound, ARENA.rightBound)
    if (bounded !== f.x) {
      f.x = bounded
      if (!f.airborne) f.vx = 0
    }
  }

  private onLand(f: Fighter): void {
    f.juggleProtected = false
    f.airAttacksUsed = 0
    if (f.state === 'KO') return
    if (f.state === 'HIT') {
      // keep the remaining hitstun on the ground
      if (f.stunFrames <= 0) f.setState('LAND')
      return
    }
    // landing cancels air attack recovery
    f.setState('LAND')
    f.vx = 0
    this.events.push('land', f.slot)
  }

  // ---------------------------------------------------------- orientation

  /**
   * Fighters always face each other, but only turn when free to act on the
   * ground — never in the middle of an attack, in the air or in hitstun.
   */
  private updateFacing(f: Fighter, opp: Fighter, frozen: boolean): void {
    if (frozen) return
    const canTurn = isGroundActionable(f.state) || f.state === 'LAND' || f.state === 'JUMP_SQUAT' || f.state === 'INTRO'
    if (!canTurn) return
    const dx = opp.x - f.x
    if (Math.abs(dx) < 2) return
    const facing: Facing = dx > 0 ? 1 : -1
    if (facing !== f.facing) {
      f.facing = facing
      // a walk that was "forward" becomes "back" after a cross-up
      if (f.state === 'WALK') {
        const forward = f.walkDir === f.facing
        f.vx = f.walkDir * (forward ? f.def.stats.walkSpeed : f.def.stats.backWalkSpeed)
      }
    }
  }

  // ------------------------------------------------------------------ hits

  private isHittable(d: Fighter): boolean {
    if (d.state === 'KO' || d.state === 'INTRO' || d.state === 'WIN') return false
    if (d.juggleProtected && d.airborne) return false
    return true
  }

  private checkHit(a: Fighter, d: Fighter, tick: number): void {
    const atk = a.attack
    if (!atk || a.attackHitDone || !isAttackState(a.state) || a.attackPhase !== 'active') return
    if (!this.isHittable(d)) return
    const hit = a.boxToRect(atk.hitbox, a.hitRect)
    const n = d.computeHurtboxes()
    for (let i = 0; i < n; i++) {
      const hurt = d.hurtRects[i]
      if (hurt && rectsOverlap(hit, hurt)) {
        this.contact.x = (Math.max(hit.left, hurt.left) + Math.min(hit.right, hurt.right)) / 2
        this.contact.y = (Math.max(hit.bottom, hurt.bottom) + Math.min(hit.top, hurt.top)) / 2
        this.resolveHit(a, d, tick)
        return
      }
    }
  }

  private isBlocking(d: Fighter, a: Fighter): boolean {
    if (d.airborne) return false
    if (d.state !== 'BLOCK' && d.state !== 'BLOCK_STUN') return false
    // must face the attacker
    const dir = a.x - d.x
    return dir === 0 || Math.sign(dir) === d.facing
  }

  private resolveHit(a: Fighter, d: Fighter, _tick: number): void {
    const atk = a.attack
    if (!atk) return
    a.attackHitDone = true
    a.attackConnected = true
    const rec = a.lastHistory()
    if (rec) rec.connected = true

    const push: Facing = d.x >= a.x ? 1 : -1
    const blocking = this.isBlocking(d, a)

    if (blocking && atk.blockInteraction === 'blockable') {
      // ---------------------------------------------------------- blocked
      const chip = Math.round(atk.damage * BLOCK.chipDamageScale)
      d.hp = Math.max(1, d.hp - chip)
      d.setState('BLOCK_STUN')
      d.stunFrames = Math.max(atk.blockstun, BLOCK.minBlockstunFrames)
      d.vx = push * atk.knockback.horizontalForce * BLOCK.pushbackScale
      a.energy = Math.min(ENERGY.max, a.energy + ENERGY.energyGainOnBlocked)
      d.energy = Math.min(ENERGY.max, d.energy + ENERGY.energyGainOnBlock)
      const hs = Math.max(2, Math.round(atk.hitstop * 0.6))
      a.hitstop = hs
      d.hitstop = hs
      const e = this.events.push('block', a.slot)
      if (e) {
        e.x = this.contact.x
        e.y = this.contact.y
        e.damage = chip
        e.sound = 'block'
      }
      return
    }

    // ------------------------------------------------------------- hit
    const guardBreak = blocking // only guardBreak attacks reach here while blocking
    const combo = a.attackCombo
    const mult = (combo ? combo.damageMultiplier : 1) * (guardBreak ? BLOCK.guardBreakDamageScale : 1)
    const damage = Math.round(atk.damage * mult)
    const kb = combo?.knockback ?? atk.knockback
    const weight = d.def.stats.weight
    const wasInHitstun = d.state === 'HIT'

    d.hp = Math.max(0, d.hp - damage)
    d.attack = null
    d.chainLength = 0
    d.clearHistory()
    d.bufferedAttack = null
    d.flashFrames = 8
    d.vx = push * kb.horizontalForce * weight
    if (kb.verticalForce > 0 || d.airborne) {
      d.vy = Math.max(kb.verticalForce * weight, d.airborne ? 6 : 0)
      d.airborne = true
      d.juggleProtected = COMBAT_CONFIG.juggleProtection
    }
    d.setState('HIT')
    d.stunFrames = kb.duration + (guardBreak ? BLOCK.guardBreakStunFrames : 0)

    a.hitstop = atk.hitstop
    d.hitstop = atk.hitstop

    // energy
    const gain = (atk.energyGain ?? ENERGY.energyGainOnHit) + (combo?.energyBonus ?? 0)
    a.energy = Math.min(ENERGY.max, a.energy + gain)
    d.energy = Math.min(ENERGY.max, d.energy + damage * ENERGY.energyGainOnDamage)

    // combo counter: hits that land while the opponent is still stunned chain
    if (wasInHitstun && a.comboActive) {
      a.comboHits++
      a.comboDamage += damage
    } else {
      a.comboHits = 1
      a.comboDamage = damage
      a.lastComboName = ''
    }
    a.comboActive = true
    a.comboDisplay = 0

    const e = this.events.push(guardBreak ? 'guardBreak' : 'hit', a.slot)
    if (e) {
      e.x = this.contact.x
      e.y = this.contact.y
      e.damage = damage
      e.impact = atk.impact
      e.sound = atk.hitSound
      e.shake = atk.screenShake ?? 0
      e.color = atk.vfxColor ?? '#ffffff'
    }
    if (combo) {
      a.lastComboName = combo.name
      const ce = this.events.push('comboFinisher', a.slot)
      if (ce) ce.text = combo.name
    }

    if (d.hp <= 0) {
      d.setState('KO')
      d.vy = Math.max(d.vy, 11)
      d.vx = push * Math.max(Math.abs(d.vx), 7)
      d.airborne = true
      const ko = this.events.push('ko', a.slot)
      if (ko) {
        ko.x = d.x
        ko.y = d.y
        ko.sound = 'ko'
      }
    }
  }

  // ---------------------------------------------------------- bookkeeping

  private bookkeeping(f: Fighter, opp: Fighter, frozen: boolean): void {
    if (frozen) return
    if (this.controlEnabled && f.state !== 'KO') {
      f.energy = Math.min(ENERGY.max, f.energy + ENERGY.regenerationPerSecond / TICK_RATE)
    }
    // the combo ends once the opponent is free again; the result stays on the HUD for a while
    if (f.comboActive && opp.state !== 'HIT' && opp.state !== 'KO') {
      f.comboActive = false
      f.comboDisplay = COMBO.displayFrames
    }
    if (!f.comboActive && f.comboDisplay > 0) {
      f.comboDisplay--
      if (f.comboDisplay === 0) {
        f.comboHits = 0
        f.comboDamage = 0
        f.lastComboName = ''
      }
    }
  }
}
