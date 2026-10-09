import { reactive, ref, watch } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { otherSlot } from '@/game/core/types'
import type { GameMode, MatchSummary } from '@/game/fight-session'
import { FIGHTERS } from '@/game/fighters/registry'
import { DEFAULT_LOCATION_ID } from '@/game/locations/locations'
import { inputManager } from '@/game/input/input-manager'
import { net } from '@/game/net/connection'
import { inputDelayForRtt } from '@/game/net/lockstep'
import { RELAY_BROKERS } from '@/game/net/transports'
import {
  controlsRecord,
  defaultStatistics,
  settingsRecord,
  statisticsRecord,
  type GameSettings,
  type Statistics,
} from '@/game/storage/records'
import { load, save } from '@/game/storage/storage'

export type Screen = 'menu' | 'online' | 'select' | 'location' | 'versus' | 'fight' | 'result' | 'controls' | 'settings'

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

/** Online play: mirror of the connection plus the opponent's menu state. */
export interface OnlineState {
  status: typeof net.status
  role: typeof net.role
  code: string
  ping: number
  /** 'p2p' = direct link, 'relay' = through a public relay */
  link: typeof net.linkKind
  /** lobby diagnostics line */
  diag: string
  error: string
  /** opponent's character select seat */
  remoteCursor: number
  remoteReady: boolean
  /** host's location carousel position */
  remoteLocation: number
  /** opponent asked for a rematch on the result screen */
  remoteRematch: boolean
  localRematch: boolean
  /** serial of the current match, counted the same way on both sides */
  matchId: number
  /** input delay of the current match, ticks */
  delay: number
  roundTime: number
}

export const online = reactive<OnlineState>({
  status: 'idle',
  role: 'host',
  code: '',
  ping: 0,
  link: null,
  diag: '',
  error: '',
  remoteCursor: 0,
  remoteReady: false,
  remoteLocation: 0,
  remoteRematch: false,
  localRematch: false,
  matchId: 0,
  delay: 3,
  roundTime: 99,
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
  if (app.mode === 'online' && screen === 'select') {
    // the opponent re-sends its seat once its select screen is up
    online.remoteReady = false
  }
  app.screen = screen
}

// ---------------------------------------------------------------- online

function syncOnline(): void {
  const was = online.status
  online.status = net.status
  online.role = net.role
  online.code = net.code
  online.ping = Math.round(net.rtt)
  online.link = net.linkKind
  const relays = `серверы ${net.relaysReady}/${RELAY_BROKERS.length}`
  online.diag =
    net.role === 'host' || net.relayTried
      ? `P2P ${net.p2pReady ? '✓' : '✗'} · ${relays}`
      : `P2P ${net.p2pReady ? '✓' : '…'}`
  online.error = net.error
  if (net.status === 'connected' && was !== 'connected') {
    // new opponent: start from a clean slate and pick fighters
    online.remoteCursor = 0
    online.remoteReady = false
    online.remoteLocation = 0
    online.remoteRematch = false
    online.localRematch = false
    online.matchId = 0
    app.mode = 'online'
    go('select')
  }
  // the opponent left: the lobby shows why (the fight screen shows its own banner)
  if (net.status === 'closed' && app.mode === 'online' && app.screen !== 'fight' && app.screen !== 'online') {
    go('online')
  }
}
net.onStatus(syncOnline)

/** Host: the match is set up — tell the guest and go to the VS screen. */
export function hostStartMatch(): void {
  const delay = inputDelayForRtt(net.rtt)
  const roundTime = settings.value.roundTimeSeconds
  net.send({ t: 'start', fighters: [...app.selection], location: app.location, roundTime, delay })
  beginOnlineMatch(delay, roundTime)
}

function beginOnlineMatch(delay: number, roundTime: number): void {
  online.delay = delay
  online.roundTime = roundTime
  online.matchId++
  online.localRematch = false
  online.remoteRematch = false
  go('versus')
}

/** Result screen: both players must ask for the rematch. */
export function requestRematch(): void {
  if (online.localRematch) return
  online.localRematch = true
  net.send({ t: 'rematch' })
  if (online.remoteRematch && online.role === 'host') hostStartMatch()
}

/** Both players back to character select. */
export function onlineBackToSelect(): void {
  net.send({ t: 'select' })
  go('select')
}

export function leaveOnline(): void {
  net.leave()
  app.mode = 'versus'
  go('menu')
}

net.onMessage((m) => {
  switch (m.t) {
    case 'seat':
      online.remoteCursor = m.cursor
      online.remoteReady = m.ready
      break
    case 'loc':
      online.remoteLocation = m.i
      break
    case 'start':
      app.selection = [m.fighters[0], m.fighters[1]]
      app.location = m.location
      beginOnlineMatch(m.delay, m.roundTime)
      break
    case 'select':
      if (app.screen !== 'select') go('select')
      break
    case 'rematch':
      online.remoteRematch = true
      // the host owns the match setup (delay, round time) and starts it
      if (online.localRematch && online.role === 'host') hostStartMatch()
      break
  }
})

export function openOptions(screen: 'controls' | 'settings'): void {
  app.returnTo = app.screen
  app.screen = screen
}

export function recordResult(summary: MatchSummary): void {
  const s = statistics.value
  app.lastResult = summary
  if (summary.mode === 'online') return // local statistics track games on this device only
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
