import type { AudioVolumes } from '../audio/audio-manager'
import type { PlayerSlot } from '../core/types'
import { INPUT_ACTIONS } from '../input/actions'
import {
  defaultControls,
  defaultPlayerControls,
  type ControlsConfig,
  type DeviceRef,
  type GamepadBindings,
  type KeyboardBindings,
  type PlayerControls,
} from '../input/bindings'
import { bool, isObject, num, type StoredRecord } from './storage'

// ------------------------------------------------------------- controls

function parseDevice(v: unknown, fallback: DeviceRef): DeviceRef {
  if (!isObject(v)) return fallback
  if (v.kind === 'keyboard') return { kind: 'keyboard' }
  if (v.kind === 'none') return { kind: 'none' }
  if (v.kind === 'gamepad') {
    return { kind: 'gamepad', index: num(v.index, 0, 0, 3), id: typeof v.id === 'string' ? v.id : null }
  }
  return fallback
}

function parseBindings<T extends string | number>(
  v: unknown,
  fallback: Record<(typeof INPUT_ACTIONS)[number], T[]>,
  isT: (x: unknown) => x is T,
): Record<(typeof INPUT_ACTIONS)[number], T[]> {
  const out = { ...fallback }
  if (!isObject(v)) return out
  for (const action of INPUT_ACTIONS) {
    const list = v[action]
    if (Array.isArray(list)) out[action] = list.filter(isT)
  }
  return out
}

const isString = (x: unknown): x is string => typeof x === 'string'
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0

function parsePlayer(v: unknown, slot: PlayerSlot): PlayerControls {
  const d = defaultPlayerControls(slot)
  if (!isObject(v)) return d
  return {
    device: parseDevice(v.device, d.device),
    keyboard: parseBindings<string>(v.keyboard, d.keyboard, isString) as KeyboardBindings,
    gamepad: parseBindings<number>(v.gamepad, d.gamepad, isInt) as GamepadBindings,
  }
}

export const controlsRecord: StoredRecord<ControlsConfig> = {
  key: 'controls',
  version: 1,
  defaults: defaultControls,
  validate(data) {
    if (!isObject(data) || !Array.isArray(data.players)) return null
    return {
      players: [parsePlayer(data.players[0], 0), parsePlayer(data.players[1], 1)],
      deadzone: num(data.deadzone, 0.35, 0.05, 0.9),
    }
  },
}

// ------------------------------------------------------------- settings

export type RoundTime = 30 | 60 | 99

export interface GameSettings {
  audio: AudioVolumes
  roundTimeSeconds: RoundTime
  showHitboxes: boolean
}

export function defaultSettings(): GameSettings {
  return {
    audio: { master: 0.8, music: 0.5, sfx: 0.8, synthFallback: true },
    roundTimeSeconds: 60,
    showHitboxes: false,
  }
}

export const settingsRecord: StoredRecord<GameSettings> = {
  key: 'settings',
  version: 1,
  defaults: defaultSettings,
  validate(data) {
    if (!isObject(data)) return null
    const d = defaultSettings()
    const a = isObject(data.audio) ? data.audio : {}
    const rt = data.roundTimeSeconds
    return {
      audio: {
        master: num(a.master, d.audio.master, 0, 1),
        music: num(a.music, d.audio.music, 0, 1),
        sfx: num(a.sfx, d.audio.sfx, 0, 1),
        synthFallback: bool(a.synthFallback, d.audio.synthFallback),
      },
      roundTimeSeconds: rt === 30 || rt === 60 || rt === 99 ? rt : d.roundTimeSeconds,
      showHitboxes: bool(data.showHitboxes, d.showHitboxes),
    }
  },
}

// ----------------------------------------------------------- statistics

export interface WinLoss {
  wins: number
  losses: number
}

export interface Statistics {
  /** player 1 against the AI */
  vsAi: WinLoss
  /** local versus: wins/losses from each seat's point of view */
  versus: [WinLoss, WinLoss]
  /** per fighter, any mode */
  fighters: Record<string, WinLoss>
}

export function defaultStatistics(): Statistics {
  return {
    vsAi: { wins: 0, losses: 0 },
    versus: [
      { wins: 0, losses: 0 },
      { wins: 0, losses: 0 },
    ],
    fighters: {},
  }
}

function parseWinLoss(v: unknown): WinLoss {
  if (!isObject(v)) return { wins: 0, losses: 0 }
  return { wins: num(v.wins, 0, 0), losses: num(v.losses, 0, 0) }
}

export const statisticsRecord: StoredRecord<Statistics> = {
  key: 'statistics',
  version: 1,
  defaults: defaultStatistics,
  validate(data) {
    if (!isObject(data)) return null
    const versus = Array.isArray(data.versus) ? data.versus : []
    const fighters: Record<string, WinLoss> = {}
    if (isObject(data.fighters)) {
      for (const [id, wl] of Object.entries(data.fighters)) fighters[id] = parseWinLoss(wl)
    }
    return {
      vsAi: parseWinLoss(data.vsAi),
      versus: [parseWinLoss(versus[0]), parseWinLoss(versus[1])],
      fighters,
    }
  },
}
