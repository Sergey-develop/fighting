import { beforeEach, describe, expect, it } from 'vitest'
import { COMBAT_CONFIG } from '../src/game/core/config'
import { EventQueue } from '../src/game/core/events'
import { CombatSystem } from '../src/game/combat/combat-system'
import { Fighter } from '../src/game/combat/fighter'
import { ACTION_BIT, createInputFrame, type InputAction, type InputFrame } from '../src/game/input/actions'
import developer from '../src/game/fighters/defs/developer'
import producer from '../src/game/fighters/defs/producer'

interface World {
  a: Fighter
  b: Fighter
  sys: CombatSystem
  events: EventQueue
  inputs: [InputFrame, InputFrame]
  tick: number
}

function makeWorld(ax = 800, bx = 960): World {
  const a = new Fighter(developer, 0)
  const b = new Fighter(producer, 1)
  a.resetForRound(ax, 1)
  b.resetForRound(bx, -1)
  a.setState('IDLE')
  b.setState('IDLE')
  const events = new EventQueue()
  const sys = new CombatSystem([a, b], events)
  sys.controlEnabled = true
  return { a, b, sys, events, inputs: [createInputFrame(), createInputFrame()], tick: 0 }
}

function bits(actions: readonly InputAction[]): number {
  return actions.reduce((m, a) => m | ACTION_BIT[a], 0)
}

/** Run n ticks. `press` is applied on the first tick only, `hold` on all. */
function run(w: World, n: number, p1: { press?: InputAction[]; hold?: InputAction[] } = {}, p2: { press?: InputAction[]; hold?: InputAction[] } = {}): void {
  for (let i = 0; i < n; i++) {
    w.events.clear()
    w.inputs[0].held = bits(p1.hold ?? [])
    w.inputs[0].pressed = i === 0 ? bits(p1.press ?? []) : 0
    w.inputs[1].held = bits(p2.hold ?? [])
    w.inputs[1].pressed = i === 0 ? bits(p2.press ?? []) : 0
    w.sys.step(w.inputs, w.tick++)
  }
}

describe('frame data', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('deals damage only once, during active frames', () => {
    const jab = developer.attacks.light
    run(w, 1, { press: ['light'] })
    expect(w.a.state).toBe('LIGHT_ATTACK')
    // startup: no damage yet
    run(w, jab.startupFrames - 2)
    expect(w.b.hp).toBe(producer.stats.maxHp)
    run(w, 4)
    expect(w.b.hp).toBe(producer.stats.maxHp - jab.damage)
    // stays hit only once for the whole move
    run(w, 30)
    expect(w.b.hp).toBe(producer.stats.maxHp - jab.damage)
  })

  it('returns to IDLE after startup + active + recovery (+ hitstop)', () => {
    w.b.x = 1500 // whiff
    const jab = developer.attacks.light
    run(w, 1, { press: ['light'] })
    run(w, jab.startupFrames + jab.activeFrames + jab.recoveryFrames)
    expect(w.a.state).toBe('IDLE')
  })

  it('whiffed attacks cannot be cancelled (anti-spam)', () => {
    w.b.x = 1500
    run(w, 1, { press: ['light'] })
    run(w, 9)
    run(w, 1, { press: ['light'] })
    // still the first jab (recovery), the second is only buffered
    expect(w.a.chainLength).toBe(1)
  })
})

describe('block', () => {
  it('blockable attacks deal chip damage and blockstun', () => {
    const w = makeWorld()
    run(w, 2, {}, { hold: ['block'] })
    expect(w.b.state).toBe('BLOCK')
    run(w, 1, { press: ['light'] }, { hold: ['block'] })
    run(w, 10, {}, { hold: ['block'] })
    const chip = Math.round(developer.attacks.light.damage * COMBAT_CONFIG.block.chipDamageScale)
    expect(w.b.hp).toBe(producer.stats.maxHp - chip)
    expect(w.b.state).toBe('BLOCK_STUN')
  })

  it('heavy breaks the block', () => {
    const w = makeWorld(800, 1050)
    run(w, 2, {}, { hold: ['block'] })
    run(w, 1, { press: ['heavy'] }, { hold: ['block'] })
    run(w, 30, {}, { hold: ['block'] })
    const dmg = Math.round(developer.attacks.heavy.damage * COMBAT_CONFIG.block.guardBreakDamageScale)
    expect(w.b.hp).toBe(producer.stats.maxHp - dmg)
    expect(w.b.state).toBe('HIT')
  })

  it('special breaks the block and costs energy', () => {
    const w = makeWorld(800, 1100)
    w.a.energy = 60
    run(w, 2, {}, { hold: ['block'] })
    run(w, 1, { press: ['special'] }, { hold: ['block'] })
    expect(w.a.state).toBe('SPECIAL')
    expect(w.a.energy).toBeCloseTo(60 - developer.special.energyCost, 0)
    run(w, 40, {}, { hold: ['block'] })
    expect(w.b.hp).toBeLessThan(producer.stats.maxHp - 100)
  })

  it('special is refused without energy', () => {
    const w = makeWorld()
    w.a.energy = 10
    run(w, 1, { press: ['special'] })
    expect(w.a.state).not.toBe('SPECIAL')
  })
})

describe('movement and orientation', () => {
  it('fighters can jump over each other and turn around after landing', () => {
    const w = makeWorld(800, 950)
    expect(w.a.facing).toBe(1)
    expect(w.b.facing).toBe(-1)
    run(w, 1, { press: ['jump'], hold: ['right'] })
    run(w, 80, { hold: ['right'] })
    expect(w.a.x).toBeGreaterThan(w.b.x)
    run(w, 10)
    expect(w.a.facing).toBe(-1)
    expect(w.b.facing).toBe(1)
  })

  it('stays inside the arena bounds', () => {
    const w = makeWorld(300, 1500)
    run(w, 200, { hold: ['left'] })
    expect(w.a.x).toBe(COMBAT_CONFIG.arena.leftBound)
  })

  it('does not turn in the middle of an attack', () => {
    const w = makeWorld(900, 1500)
    run(w, 1, { press: ['kick'] })
    w.b.x = 500 // opponent teleports behind
    run(w, 5)
    expect(w.a.facing).toBe(1)
    run(w, 40)
    expect(w.a.facing).toBe(-1)
  })
})

describe('combos', () => {
  it('recognises X → X → B (light, light, kick) and counts hits', () => {
    const w = makeWorld(800, 950)
    run(w, 1, { press: ['light'] })
    run(w, 9)
    run(w, 1, { press: ['light'] })
    run(w, 11)
    run(w, 1, { press: ['kick'] })
    expect(w.a.state).toBe('KICK')
    expect(w.a.attackCombo?.id).toBe('dev-hotfix')
    run(w, 20)
    expect(w.a.comboHits).toBe(3)
    expect(w.a.lastComboName).toBe('Хотфикс')
  })

  it('slow inputs are not a combo', () => {
    const w = makeWorld(800, 950)
    run(w, 1, { press: ['light'] })
    run(w, 80)
    run(w, 1, { press: ['light'] })
    run(w, 80)
    run(w, 1, { press: ['kick'] })
    expect(w.a.attackCombo).toBeNull()
  })

  it('no air combos: one air attack per jump, launched opponents are protected', () => {
    const w = makeWorld(800, 1000)
    run(w, 1, { press: ['jump'] })
    run(w, 8)
    run(w, 1, { press: ['light'] })
    expect(w.a.airAttacksUsed).toBe(1)
    run(w, 20)
    run(w, 1, { press: ['light'] })
    expect(w.a.airAttacksUsed).toBe(1)
  })
})
