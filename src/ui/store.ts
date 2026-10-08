import { reactive, ref, watch } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { otherSlot } from '@/game/core/types'
import type { GameMode, MatchSummary } from '@/game/fight-session'
import { FIGHTERS } from '@/game/fighters/registry'
import { DEFAULT_LOCATION_ID } from '@/game/locations/locations'
import { inputManager } from '@/game/input/input-manager'
import {
  controlsRecord,
  defaultStatistics,
  settingsRecord,
  statisticsRecord,
  type GameSettings,
  type Statistics,
} from '@/game/storage/records'
import { load, save } from '@/game/storage/storage'

export type Screen = 'menu' | 'select' | 'location' | 'versus' | 'fight' | 'result' | 'controls' | 'settings'

export interface AppState {
  screen: Screen
  mode: GameMode
  selection: [string, string]
  /** chosen arena */
  location: string
  lastResult: MatchSummary | null
  /** bumps to force a fresh FightScreen on rematch */
  fightSerial: number
  /** where the Controls / Settings screens return to */
  returnTo: Screen
}

const firstId = FIGHTERS[0]?.id ?? ''
const secondId = FIGHTERS[1]?.id ?? firstId

export const app = reactive<AppState>({
  screen: 'menu',
  mode: 'versus',
  selection: [firstId, secondId],
  location: DEFAULT_LOCATION_ID,
  lastResult: null,
  fightSerial: 0,
  returnTo: 'menu',
})

export const settings = ref<GameSettings>(load(settingsRecord))
export const statistics = ref<Statistics>(load(statisticsRecord))

// controls live inside the InputManager (the only consumer at runtime)
inputManager.controls = load(controlsRecord)

export function saveControls(): void {
  save(controlsRecord, inputManager.controls)
}

watch(
  settings,
  (s) => {
    save(settingsRecord, s)
    audioManager.setVolumes(s.audio)
  },
  { deep: true, immediate: true },
)

export function go(screen: Screen): void {
  app.screen = screen
}

export function openOptions(screen: 'controls' | 'settings'): void {
  app.returnTo = app.screen
  app.screen = screen
}

export function recordResult(summary: MatchSummary): void {
  const s = statistics.value
  const loser = otherSlot(summary.winner)
  if (summary.mode === 'ai') {
    if (summary.winner === 0) s.vsAi.wins++
    else s.vsAi.losses++
  } else {
    s.versus[summary.winner].wins++
    s.versus[loser].losses++
  }
  const wId = summary.fighters[summary.winner]
  const lId = summary.fighters[loser]
  const fw = (s.fighters[wId] ??= { wins: 0, losses: 0 })
  fw.wins++
  const fl = (s.fighters[lId] ??= { wins: 0, losses: 0 })
  fl.losses++
  save(statisticsRecord, s)
  app.lastResult = summary
}

export function resetStatistics(): void {
  statistics.value = defaultStatistics()
  save(statisticsRecord, statistics.value)
}
