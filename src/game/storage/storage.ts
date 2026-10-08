/**
 * Typed, versioned localStorage layer. The only module that touches
 * window.localStorage. Each key stores { version, data }; on load, older
 * versions run through migrations, and anything invalid falls back to defaults.
 */

interface Envelope {
  version: number
  data: unknown
}

export interface StoredRecord<T> {
  key: string
  version: number
  defaults: () => T
  /** returns a valid T or null; may fill missing fields from defaults */
  validate: (data: unknown) => T | null
  /** migrations[v] upgrades data from version v to v + 1 */
  migrations?: Readonly<Record<number, (data: unknown) => unknown>>
}

const PREFIX = 'fighting.'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // disabled storage / privacy mode
  }
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null && 'version' in v && typeof v.version === 'number' && 'data' in v
}

export function load<T>(rec: StoredRecord<T>): T {
  const ls = storage()
  if (!ls) return rec.defaults()
  let raw: string | null
  try {
    raw = ls.getItem(PREFIX + rec.key)
  } catch {
    return rec.defaults()
  }
  if (!raw) return rec.defaults()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isEnvelope(parsed)) return rec.defaults()
    let { version, data } = parsed
    if (version > rec.version) return rec.defaults() // written by a newer build
    while (version < rec.version) {
      const migrate = rec.migrations?.[version]
      if (!migrate) return rec.defaults()
      data = migrate(data)
      version++
    }
    return rec.validate(data) ?? rec.defaults()
  } catch {
    return rec.defaults()
  }
}

export function save<T>(rec: StoredRecord<T>, value: T): void {
  const ls = storage()
  if (!ls) return
  const env: Envelope = { version: rec.version, data: value }
  try {
    ls.setItem(PREFIX + rec.key, JSON.stringify(env))
  } catch {
    // quota exceeded / disabled — settings simply won't persist
  }
}

export function remove<T>(rec: StoredRecord<T>): void {
  try {
    storage()?.removeItem(PREFIX + rec.key)
  } catch {
    // ignore
  }
}

// ----------------------------------------------------------- validators

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
