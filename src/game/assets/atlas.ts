/**
 * Runtime side of tools/slice_sprites.py: loads atlas.json + atlas.webp for a
 * fighter. Frame coordinates are in atlas pixels; (ax, ay) is the frame's
 * anchor — the centre of the feet on the floor.
 */

export interface AtlasFrame {
  x: number
  y: number
  w: number
  h: number
  ax: number
  ay: number
}

export interface AtlasManifest {
  image: string
  portraits: readonly string[]
  rows: readonly (readonly AtlasFrame[])[]
}

export interface SpriteAtlas {
  readonly image: HTMLImageElement
  readonly rows: readonly (readonly AtlasFrame[])[]
  readonly portraitUrls: readonly string[]
}

const BASE = `${import.meta.env.BASE_URL}assets/fighters/`

export function fighterAssetUrl(assetDir: string, file: string): string {
  return `${BASE}${assetDir}/${file}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function parseFrame(v: unknown): AtlasFrame {
  if (!isRecord(v)) throw new Error('atlas frame is not an object')
  const { x, y, w, h, ax, ay } = v
  if (!isNumber(x) || !isNumber(y) || !isNumber(w) || !isNumber(h) || !isNumber(ax) || !isNumber(ay)) {
    throw new Error('atlas frame has invalid coordinates')
  }
  return { x, y, w, h, ax, ay }
}

export function parseManifest(json: unknown): AtlasManifest {
  if (!isRecord(json)) throw new Error('atlas.json is not an object')
  const { image, portraits, rows } = json
  if (typeof image !== 'string') throw new Error('atlas.json: image missing')
  if (!Array.isArray(portraits) || !portraits.every((p): p is string => typeof p === 'string')) {
    throw new Error('atlas.json: portraits invalid')
  }
  if (!Array.isArray(rows)) throw new Error('atlas.json: rows invalid')
  return {
    image,
    portraits,
    rows: rows.map((row: unknown) => {
      if (!Array.isArray(row)) throw new Error('atlas.json: row is not an array')
      return row.map(parseFrame)
    }),
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

const cache = new Map<string, Promise<SpriteAtlas>>()

export function loadAtlas(assetDir: string): Promise<SpriteAtlas> {
  let p = cache.get(assetDir)
  if (!p) {
    p = (async () => {
      const res = await fetch(fighterAssetUrl(assetDir, 'atlas.json'))
      if (!res.ok) throw new Error(`atlas.json for ${assetDir}: HTTP ${res.status}`)
      const manifest = parseManifest(await res.json())
      const image = await loadImage(fighterAssetUrl(assetDir, manifest.image))
      return {
        image,
        rows: manifest.rows,
        portraitUrls: manifest.portraits.map((f) => fighterAssetUrl(assetDir, f)),
      }
    })()
    p.catch(() => cache.delete(assetDir))
    cache.set(assetDir, p)
  }
  return p
}
