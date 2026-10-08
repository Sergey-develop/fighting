import { FIGHTERS } from './registry'
import type { FighterDefinition, FighterProfileText } from './types'

/**
 * The character-select grid, in the order of the mock-up. A slot is playable
 * when a FighterDefinition with its id exists in ./defs — adding e.g.
 * defs/catering.ts with id "catering" unlocks that slot automatically.
 * Locked portraits come from the mock-up and are shown as silhouettes.
 */
interface SlotSpec {
  id: string
  /** shown while locked; null = unknown ("???") */
  name: string | null
  profile: FighterProfileText | null
  /** portrait in public/assets/roster for the locked state */
  lockedPortrait: string
}

const SLOTS: readonly SlotSpec[] = [
  { id: 'developer', name: null, profile: null, lockedPortrait: '' },
  {
    id: 'catering',
    name: 'Кейтеринг',
    profile: { archetype: 'Пожиратель галактик', speed: 'Низкая', health: 'Выше высоких' },
    lockedPortrait: 'locked-2.webp',
  },
  { id: 'producer', name: null, profile: null, lockedPortrait: '' },
  { id: 'locked-4', name: null, profile: null, lockedPortrait: 'locked-4.webp' },
  { id: 'locked-5', name: null, profile: null, lockedPortrait: 'locked-5.webp' },
  { id: 'locked-6', name: null, profile: null, lockedPortrait: 'locked-6.webp' },
  { id: 'locked-7', name: null, profile: null, lockedPortrait: 'locked-7.webp' },
  { id: 'locked-8', name: null, profile: null, lockedPortrait: 'locked-8.webp' },
  { id: 'locked-9', name: null, profile: null, lockedPortrait: 'locked-9.webp' },
]

export type RosterEntry =
  | { kind: 'fighter'; id: string; fighter: FighterDefinition }
  | { kind: 'locked'; id: string; name: string | null; profile: FighterProfileText | null; portrait: string }

const BASE = `${import.meta.env.BASE_URL}assets/roster/`

function build(): RosterEntry[] {
  const out: RosterEntry[] = SLOTS.map((s): RosterEntry => {
    const fighter = FIGHTERS.find((f) => f.id === s.id)
    if (fighter) return { kind: 'fighter', id: s.id, fighter }
    return { kind: 'locked', id: s.id, name: s.name, profile: s.profile, portrait: BASE + s.lockedPortrait }
  })
  // fighters that have no slot yet are appended, never hidden
  for (const f of FIGHTERS) {
    if (!SLOTS.some((s) => s.id === f.id)) out.push({ kind: 'fighter', id: f.id, fighter: f })
  }
  return out
}

export const ROSTER: readonly RosterEntry[] = build()

export function rosterIndexOf(fighterId: string): number {
  return ROSTER.findIndex((e) => e.kind === 'fighter' && e.id === fighterId)
}
