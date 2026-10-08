import type { AttackKind, ComboDefinition } from '../fighters/types'
import type { Fighter } from './fighter'

/**
 * Does `seq[0..count-1]` match the fighter's most recent `count` attacks,
 * all connected and each started within the combo's timing window?
 * `nextTick` is the start tick of the attack that would follow them.
 */
function matchesRecent(f: Fighter, combo: ComboDefinition, count: number, nextTick: number): boolean {
  let laterTick = nextTick
  for (let k = 0; k < count; k++) {
    const rec = f.historyBack(k)
    const expected = combo.sequence[count - 1 - k]
    if (!rec || rec.kind !== expected || !rec.connected) return false
    if (laterTick - rec.tick > combo.maxGapFrames) return false
    laterTick = rec.tick
  }
  return true
}

/**
 * Called before a new attack of `kind` is pushed to history: returns the
 * combo this attack would finish (longest match wins), or null.
 */
export function findComboFinisher(f: Fighter, kind: AttackKind, tick: number): ComboDefinition | null {
  let best: ComboDefinition | null = null
  for (const combo of f.def.combos) {
    const len = combo.sequence.length
    if (len < 2 || combo.sequence[len - 1] !== kind) continue
    if (f.historyCount < len - 1) continue
    if (!matchesRecent(f, combo, len - 1, tick)) continue
    if (!best || len > best.sequence.length) best = combo
  }
  return best
}

/**
 * Called while an attack is in progress (already in history): true if some
 * combo of the fighter continues with `kind` from the current chain. This
 * makes every combo route cancellable even if `cancelInto` does not list it.
 */
export function comboContinuesWith(f: Fighter, kind: AttackKind, tick: number): boolean {
  for (const combo of f.def.combos) {
    const seq = combo.sequence
    for (let p = 1; p < seq.length; p++) {
      if (seq[p] !== kind) continue
      if (f.historyCount < p) continue
      if (matchesRecent(f, combo, p, tick)) return true
    }
  }
  return false
}
