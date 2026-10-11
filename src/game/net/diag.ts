/**
 * Temporary online diagnostics. Every line starts with [NET-DIAG] so players
 * can copy just these lines from the browser console (F12 → Console).
 * Never log full room codes or other identifying data: use maskCode().
 */

const t0 = typeof performance !== 'undefined' ? performance.now() : 0

/** "K5K25" → "K5***" */
export function maskCode(code: string): string {
  return code.length <= 2 ? '***' : `${code.slice(0, 2)}***`
}

/** Short opaque ids (relay inbox ids) are shown only by their first 3 chars. */
export function maskId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 3)}…` : '-'
}

/** Per-tick traffic is sampled: the first ticks of a match, then every second. */
export function sampleTick(tick: number): boolean {
  return tick < 10 || tick % 60 === 0
}

export function netDiag(event: string, data?: Record<string, unknown>): void {
  const at = ((typeof performance !== 'undefined' ? performance.now() : 0) - t0) / 1000
  if (data) console.info(`[NET-DIAG] +${at.toFixed(2)}s ${event}`, JSON.stringify(data))
  else console.info(`[NET-DIAG] +${at.toFixed(2)}s ${event}`)
}
