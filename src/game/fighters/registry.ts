import type { SpriteAtlas } from '../assets/atlas'
import type { AttackAnimation, FighterDefinition, LoopAnimation } from './types'

/**
 * Every module in ./defs/ that default-exports a FighterDefinition is picked
 * up automatically — adding a fighter never touches the combat code.
 * Order on the select screen follows the file name.
 */
const modules = import.meta.glob<{ default: FighterDefinition }>('./defs/*.ts', { eager: true })

export const FIGHTERS: readonly FighterDefinition[] = Object.keys(modules)
  .sort()
  .map((k) => {
    const mod = modules[k]
    if (!mod) throw new Error(`fighter module ${k} missing`)
    return mod.default
  })

export function getFighter(id: string): FighterDefinition {
  const f = FIGHTERS.find((d) => d.id === id)
  if (!f) throw new Error(`unknown fighter "${id}"`)
  return f
}

export function hasFighter(id: string): boolean {
  return FIGHTERS.some((d) => d.id === id)
}

/**
 * Checks that every frame referenced by a definition exists in its atlas.
 * Returns human-readable problems (empty = valid).
 */
export function validateFighter(def: FighterDefinition, atlas: SpriteAtlas): string[] {
  const problems: string[] = []
  const check = (where: string, row: number, frames: readonly number[]): void => {
    const r = atlas.rows[row - 1]
    if (!r) {
      problems.push(`${def.id}.${where}: atlas row ${row} missing`)
      return
    }
    for (const f of frames) {
      if (!r[f]) problems.push(`${def.id}.${where}: frame ${row}:${f} missing`)
    }
  }
  const checkLoop = (where: string, a: LoopAnimation): void => {
    if (a.frames.length === 0) problems.push(`${def.id}.${where}: no frames`)
    check(where, a.row, a.frames)
  }
  const checkAttack = (where: string, a: AttackAnimation): void => {
    check(where, a.row, [...a.startup, ...a.active, ...a.recovery])
    if (a.overlay) check(`${where}.overlay`, a.overlay.row, [...a.overlay.active, ...a.overlay.recovery])
  }
  for (const [name, anim] of Object.entries(def.animations)) {
    if (anim) checkLoop(`animations.${name}`, anim)
  }
  for (const [name, atk] of Object.entries(def.attacks)) {
    checkAttack(`attacks.${name}`, atk.animation)
  }
  checkAttack('special', def.special.animation)
  return problems
}
