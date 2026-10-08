import { expect, it } from 'vitest'
import { AiController } from '../src/game/ai/ai-controller'
import { CombatSystem } from '../src/game/combat/combat-system'
import { Fighter } from '../src/game/combat/fighter'
import { EventQueue } from '../src/game/core/events'
import { createInputFrame, type InputFrame } from '../src/game/input/actions'
import developer from '../src/game/fighters/defs/developer'
import producer from '../src/game/fighters/defs/producer'
import { FighterFx } from '../src/game/render/fighter-fx'
import { Match } from '../src/game/rounds/match'
import { VfxSystem } from '../src/game/vfx/vfx'

it('procedural fighter fx stay bounded and produce trails, dust and aura', () => {
  let seed = 5
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const a = new Fighter(developer, 0)
  const b = new Fighter(producer, 1)
  const events = new EventQueue()
  const combat = new CombatSystem([a, b], events)
  const match = new Match([a, b], combat)
  const ai = [new AiController(a, b, undefined, rnd), new AiController(b, a, undefined, rnd)]
  const inputs: [InputFrame, InputFrame] = [createInputFrame(), createInputFrame()]
  const vfx = new VfxSystem()
  const fx = [new FighterFx(), new FighterFx()]
  let ghosts = 0
  let dust = 0
  let embers = 0
  let maxAura = 0
  const seen = new Set<string>()
  let bolts = 0
  match.startMatch()
  for (let t = 0; t < 60 * 90 && !match.isOver; t++) {
    ai[0]?.observe()
    ai[1]?.observe()
    ai[0]?.readTick(inputs[0])
    ai[1]?.readTick(inputs[1])
    events.clear()
    combat.step(inputs, t)
    match.step()
    vfx.update()
    for (const i of [0, 1] as const) {
      const f = fx[i]
      if (!f) continue
      f.update(i === 0 ? a : b, vfx)
      expect(Number.isFinite(f.sx + f.sy + f.rot + f.ox + f.oy)).toBe(true)
      expect(f.sx).toBeGreaterThan(0.7)
      expect(f.sx).toBeLessThan(1.3)
      expect(Math.abs(f.rot)).toBeLessThan(0.5)
      ghosts += f.ghosts.filter((g) => g.life > 0).length
      maxAura = Math.max(maxAura, f.aura)
      if (f.boltAlpha > 0) bolts++
      for (const v of f.bolts) expect(Number.isFinite(v)).toBe(true)
    }
    dust += vfx.particles.filter((p) => p.active && p.kind === 'dust').length
    embers += vfx.particles.filter((p) => p.active && p.kind === 'ember').length
    for (const p of vfx.particles) if (p.active) seen.add(p.kind)
  }
  expect(ghosts).toBeGreaterThan(0)
  expect(dust).toBeGreaterThan(0)
  expect(embers).toBeGreaterThan(0)
  expect(maxAura).toBeGreaterThan(0.5)
  // baked-in effects get their procedural layer
  expect(bolts).toBeGreaterThan(0) // developer's lightning special
  expect(seen.has('bill') || seen.has('coin')).toBe(true) // producer's money spray
  expect(seen.has('glyph')).toBe(true) // developer's code pillar
  expect(seen.has('shock')).toBe(true)
})
