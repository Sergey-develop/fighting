/**
 * Arenas. A location is unlocked as soon as its background exists in /scene
 * under the location's name (e.g. scene/Завидово.png) — no code changes.
 */
const sceneFiles = import.meta.glob<string>('/scene/*.{png,jpg,jpeg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
})

function sceneImage(name: string): string | null {
  for (const [path, url] of Object.entries(sceneFiles)) {
    const base = path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'))
    const decoded = decodeURIComponent(base)
    if (base.toLowerCase() === name.toLowerCase() || decoded.toLowerCase() === name.toLowerCase()) return url
  }
  return null
}

export interface LocationDefinition {
  id: string
  name: string
  /** arena background, null = not available yet (location locked) */
  image: string | null
}

export function isLocationLocked(l: LocationDefinition): boolean {
  return l.image === null
}

/** Order as on the location-select mock-up. */
export const LOCATIONS: readonly LocationDefinition[] = [
  { id: 'barvikha', name: 'Барвиха' },
  { id: 'krasnaya-polyana', name: 'Красная поляна' },
  { id: 'zavidovo', name: 'Завидово' },
  { id: 'vdnh', name: 'ВДНХ' },
  { id: 'red-square', name: 'Красная площадь' },
].map((l) => ({ ...l, image: sceneImage(l.name) }))

/** Any background in /scene, used for menus when no location matches by name. */
const FALLBACK_SCENE: string | null = Object.keys(sceneFiles).sort().map((k) => sceneFiles[k] ?? '')[0] ?? null

export const DEFAULT_LOCATION_ID: string = LOCATIONS.find((l) => l.image)?.id ?? 'zavidovo'

export function getLocation(id: string): LocationDefinition | undefined {
  return LOCATIONS.find((l) => l.id === id)
}

/** Background image for an arena (falls back to any scene image). */
export function locationImage(id: string): string | null {
  return getLocation(id)?.image ?? FALLBACK_SCENE
}

/** Backdrop for menus: the default arena. */
export function sceneImageUrl(): string | null {
  return locationImage(DEFAULT_LOCATION_ID)
}
