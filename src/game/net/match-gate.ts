/**
 * Fight start gate: each side loads the fight, then announces the match setup
 * it is about to simulate. The fight starts only when the opponent's setup has
 * arrived and is identical — the lockstep needs the same match id, fighters,
 * arena, round time and input delay on both sides.
 */

export interface MatchSetup {
  matchId: number
  fighters: [string, string]
  location: string
  roundTime: number
  /** lockstep input delay, ticks */
  delay: number
}

export type GateStatus =
  | { state: 'waiting' }
  | { state: 'go' }
  | { state: 'mismatch'; fields: string[] }
  | { state: 'failed'; reason: string }

/** Names of the fields that differ. */
export function setupMismatch(a: MatchSetup, b: MatchSetup): string[] {
  const out: string[] = []
  if (a.matchId !== b.matchId) out.push('matchId')
  if (a.fighters[0] !== b.fighters[0] || a.fighters[1] !== b.fighters[1]) out.push('fighters')
  if (a.location !== b.location) out.push('location')
  if (a.roundTime !== b.roundTime) out.push('roundTime')
  if (a.delay !== b.delay) out.push('delay')
  return out
}

export class MatchGate {
  /** opponent's announced setup per match id (first one wins) */
  private readonly remote = new Map<number, MatchSetup>()
  private readonly conflicts = new Map<number, string[]>()
  private readonly failures = new Map<number, string>()

  /** Opponent loaded its fight. Repeats are harmless. */
  remoteReady(s: MatchSetup): 'new' | 'duplicate' | 'conflict' {
    const known = this.remote.get(s.matchId)
    if (!known) {
      this.remote.set(s.matchId, { ...s, fighters: [s.fighters[0], s.fighters[1]] })
      return 'new'
    }
    const diff = setupMismatch(known, s)
    if (!diff.length) return 'duplicate'
    // the same match announced twice with different data: never trust it
    this.conflicts.set(s.matchId, diff)
    return 'conflict'
  }

  /** Opponent could not load the fight. */
  remoteFailed(matchId: number, reason: string): void {
    if (!this.failures.has(matchId)) this.failures.set(matchId, reason)
  }

  check(local: MatchSetup): GateStatus {
    const failure = this.failures.get(local.matchId)
    if (failure !== undefined) return { state: 'failed', reason: failure }
    const conflict = this.conflicts.get(local.matchId)
    if (conflict) return { state: 'mismatch', fields: conflict }
    const remote = this.remote.get(local.matchId)
    if (!remote) return { state: 'waiting' }
    const diff = setupMismatch(local, remote)
    return diff.length ? { state: 'mismatch', fields: diff } : { state: 'go' }
  }

  /** Drop data of matches before `matchId`. */
  forgetBefore(matchId: number): void {
    for (const map of [this.remote, this.conflicts, this.failures]) {
      for (const id of map.keys()) if (id < matchId) map.delete(id)
    }
  }

  clear(): void {
    this.remote.clear()
    this.conflicts.clear()
    this.failures.clear()
  }
}
