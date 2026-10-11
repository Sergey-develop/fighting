<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { FightSession } from '@/game/fight-session'
import { inputManager } from '@/game/input/input-manager'
import { locationImage } from '@/game/locations/locations'
import { net } from '@/game/net/connection'
import { netDiag } from '@/game/net/diag'
import FightHud from '../components/FightHud.vue'
import PauseMenu from '../components/PauseMenu.vue'
import TouchControls from '../components/TouchControls.vue'
import { app, go, leaveOnline, localMatchSetup, matchGate, online, recordResult, settings } from '../store'

const canvas = ref<HTMLCanvasElement | null>(null)
const session = shallowRef<FightSession | null>(null)
const error = ref<string | null>(null)
/** low-frequency UI state mirrored from the HUD bridge */
const paused = ref(false)
const disconnected = ref<[boolean, boolean]>([false, false])
const labels: [string, string] = app.mode === 'ai' ? ['PLAYER 1', 'AI'] : ['PLAYER 1', 'PLAYER 2']
const isOnline = app.mode === 'online'
/** online: the opponent's input is late */
const netWaiting = ref(false)
const desynced = ref(false)
/** online: the connection dropped mid-fight */
const netLost = computed(() => isOnline && online.status !== 'connected')
let unsubscribe: (() => void) | null = null
let destroyed = false

/** After this long the waiting screens say the opponent isn't responding (the match is NOT ended). */
const NO_RESPONSE_MS = 15000
/**
 * Online start gate: 'gate' = loaded, waiting for the opponent's matching
 * setup; 'running' = started; 'blocked' = setups differ / opponent failed.
 */
const phase = ref<'loading' | 'gate' | 'running' | 'blocked'>('loading')
const gateSince = ref(0)
/** online: ms the fight has been waiting for the opponent's input */
const stallMs = ref(0)
const stallTick = ref(0)
const now = ref(performance.now())
const clock = window.setInterval(() => {
  now.value = performance.now()
  const s = session.value
  if (!s || phase.value !== 'running') return
  const ms = s.stallMs
  if (ms >= NO_RESPONSE_MS && stallMs.value < NO_RESPONSE_MS) {
    netDiag('fight: opponent not responding (match kept waiting)', { match: online.matchId, tick: s.stallTick, waitedMs: Math.round(ms) })
  }
  stallMs.value = ms
  stallTick.value = s.stallTick
}, 500)
const gateWaitSec = computed(() => Math.floor((now.value - gateSince.value) / 1000))

function startWhenOpponentReady(): void {
  const s = session.value
  if (!s || phase.value !== 'gate') return
  const local = localMatchSetup()
  const status = matchGate.check(local)
  if (status.state === 'waiting') return
  netDiag('fight: start gate', { match: local.matchId, ...status })
  if (status.state === 'go') {
    phase.value = 'running'
    s.start()
    return
  }
  phase.value = 'blocked'
  error.value =
    status.state === 'failed'
      ? `У соперника не загрузился бой: ${status.reason}`
      : `Параметры матча у игроков не совпали (${status.fields.join(', ')}). Вернитесь в меню и начните заново.`
}
watch(() => online.gateSerial, startWhenOpponentReady)

onMounted(async () => {
  const el = canvas.value
  if (!el) return
  try {
    const s = await FightSession.create(
      el,
      {
        mode: app.mode,
        fighters: [...app.selection],
        // online the host's round time is used on both sides
        roundTimeSeconds: isOnline ? online.roundTime : settings.value.roundTimeSeconds,
        showHitboxes: settings.value.showHitboxes,
        stageImage: locationImage(app.location),
        online: isOnline
          ? { link: net, localSlot: net.localSlot, matchId: online.matchId, delay: online.delay }
          : undefined,
      },
      inputManager,
    )
    if (destroyed) return
    s.onMatchEnd = (summary) => {
      recordResult(summary)
      go('result')
    }
    unsubscribe = s.hud.subscribe((snap) => {
      if (snap.paused !== paused.value) paused.value = snap.paused
      if (s.netWaiting !== netWaiting.value) netWaiting.value = s.netWaiting
      if (s.desynced !== desynced.value) desynced.value = s.desynced
      if (snap.disconnected[0] !== disconnected.value[0] || snap.disconnected[1] !== disconnected.value[1]) {
        disconnected.value = [snap.disconnected[0], snap.disconnected[1]]
      }
    })
    session.value = s
    if (!isOnline) {
      phase.value = 'running'
      s.start()
      return
    }
    // tell the opponent what we loaded, start once its matching report is in
    const local = localMatchSetup()
    net.send({ t: 'fightready', m: local.matchId, fighters: local.fighters, location: local.location, roundTime: local.roundTime, delay: local.delay })
    netDiag('fight: loaded, waiting for opponent', { match: local.matchId, fighters: local.fighters, location: local.location, roundTime: local.roundTime, delay: local.delay })
    phase.value = 'gate'
    gateSince.value = performance.now()
    startWhenOpponentReady()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    phase.value = 'blocked'
    if (isOnline) {
      // otherwise the opponent would wait for us forever
      net.send({ t: 'fightfail', m: online.matchId, reason: error.value.slice(0, 200) })
      netDiag('fight: failed to load', { match: online.matchId, error: error.value.slice(0, 200) })
    }
  }
})

onBeforeUnmount(() => {
  window.clearInterval(clock)
  destroyed = true
  unsubscribe?.()
  session.value?.destroy()
})

function pause(): void {
  session.value?.setPaused(true)
  paused.value = session.value?.paused ?? false
}

function resume(): void {
  session.value?.setPaused(false)
  paused.value = session.value?.paused ?? false
}

function quit(): void {
  if (isOnline) leaveOnline()
  else go('menu')
}

/** Same fighters, fresh match: re-keys this screen, which builds a new session. */
function restart(): void {
  app.fightSerial++
}
</script>

<template>
  <div class="screen fight">
    <canvas ref="canvas" class="arena" />
    <FightHud v-if="session" :bridge="session.hud" :fighter-ids="app.selection" :labels="labels" />
    <div v-if="!session && !error" class="loading title">ЗАГРУЗКА...</div>
    <div v-if="error" class="error panel">
      <p>{{ phase === 'blocked' && session ? 'Бой не может начаться' : 'Не удалось загрузить бой' }}</p>
      <pre>{{ error }}</pre>
      <button class="btn" @click="quit">Главное меню</button>
    </div>
    <TouchControls v-if="session && !paused && !netLost" @pause="pause" />
    <div v-if="isOnline && session" class="net-info hint">
      {{ online.link === 'relay' ? 'через сервер' : 'напрямую' }} · пинг {{ online.ping }} мс · задержка {{ online.delay }}
      <span v-if="desynced" class="desync">· рассинхрон!</span>
    </div>
    <div v-if="phase === 'gate' && !netLost" class="net-gate panel">
      <p>Ждём, пока соперник загрузит бой... {{ gateWaitSec }} с</p>
      <template v-if="gateWaitSec * 1000 >= NO_RESPONSE_MS">
        <p class="warn">Соперник не отвечает. Можно подождать ещё или выйти.</p>
        <button class="btn ghost" @click="quit">Выйти</button>
      </template>
    </div>
    <div v-if="phase === 'running' && netWaiting && !netLost" class="net-wait title">Ожидание соперника...</div>
    <div v-if="phase === 'running' && stallMs >= NO_RESPONSE_MS && !netLost" class="net-stall panel">
      <p>Соперник не отвечает {{ Math.floor(stallMs / 1000) }} с (кадр {{ stallTick }})</p>
      <p class="warn">Матч не завершён — продолжится, как только придут его ходы.</p>
      <button class="btn ghost" @click="quit">Выйти</button>
    </div>
    <div v-if="netLost" class="net-lost panel">
      <p>{{ online.error || 'Соединение потеряно' }}</p>
      <button class="btn" @click="quit">Главное меню</button>
    </div>
    <PauseMenu
      v-else-if="paused"
      :disconnected="disconnected"
      :online="isOnline"
      @resume="resume"
      @restart="restart"
      @quit="quit"
    />
  </div>
</template>

<style scoped>
.net-gate,
.net-stall {
  position: absolute;
  top: 55%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 1.5cqw 2.5cqw;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1cqw;
  font-size: 1cqw;
  text-align: center;
}
.warn {
  color: var(--danger);
  margin: 0;
}
.net-info {
  position: absolute;
  left: 50%;
  bottom: 0.6cqw;
  transform: translateX(-50%);
  font-size: 0.6cqw;
  opacity: 0.7;
  pointer-events: none;
}
.desync {
  color: var(--danger);
}
.net-wait {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 2cqw;
  pointer-events: none;
}
.net-lost {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 2cqw 3cqw;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5cqw;
  font-size: 1.1cqw;
  text-align: center;
}
.arena {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.loading {
  margin: auto;
  font-size: 2.5cqw;
}
.error {
  margin: auto;
  padding: 2cqw;
  max-width: 70cqw;
  font-size: 0.9cqw;
  line-height: 1.6;
}
.error pre {
  white-space: pre-wrap;
  font-size: 0.7cqw;
  color: var(--danger);
}
</style>
