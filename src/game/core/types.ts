/** Index of a player seat in a match. */
export type PlayerSlot = 0 | 1

export const PLAYER_SLOTS: readonly PlayerSlot[] = [0, 1]

export function otherSlot(slot: PlayerSlot): PlayerSlot {
  return slot === 0 ? 1 : 0
}

/** +1 = facing right (sprites are authored facing right), -1 = facing left. */
export type Facing = 1 | -1

/**
 * Axis-aligned rectangle in world space.
 * World space: x grows to the right, y is height above the floor (grows up).
 */
export interface Rect {
  left: number
  right: number
  bottom: number
  top: number
}

export function createRect(): Rect {
  return { left: 0, right: 0, bottom: 0, top: 0 }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target)
  if (v > target) return Math.max(v - step, target)
  return v
}
