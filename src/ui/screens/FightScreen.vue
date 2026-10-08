<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { FightSession } from '@/game/fight-session'
import { inputManager } from '@/game/input/input-manager'
import { locationImage } from '@/game/locations/locations'
import FightHud from '../components/FightHud.vue'
import PauseMenu from '../components/PauseMenu.vue'
import { app, go, recordResult, settings } from '../store'

const canvas = ref<HTMLCanvasElement | null>(null)
const session = shallowRef<FightSession | null>(null)
const error = ref<string | null>(null)
/** low-frequency UI state mirrored from the HUD bridge */
const paused = ref(false)
const disconnected = ref<[boolean, boolean]>([false, false])
const labels: [string, string] = app.mode === 'ai' ? ['PLAYER 1', 'AI'] : ['PLAYER 1', 'PLAYER 2']
let unsubscribe: (() => void) | null = null
let destroyed = false

onMounted(async () => {
  const el = canvas.value
  if (!el) return
  try {
    const s = await FightSession.create(
      el,
      {
        mode: app.mode,
        fighters: [...app.selection],
        roundTimeSeconds: settings.value.roundTimeSeconds,
        showHitboxes: settings.value.showHitboxes,
        stageImage: locationImage(app.location),
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
      if (snap.disconnected[0] !== disconnected.value[0] || snap.disconnected[1] !== disconnected.value[1]) {
        disconnected.value = [snap.disconnected[0], snap.disconnected[1]]
      }
    })
    session.value = s
    s.start()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

onBeforeUnmount(() => {
  destroyed = true
  unsubscribe?.()
  session.value?.destroy()
})

function resume(): void {
  session.value?.setPaused(false)
  paused.value = session.value?.paused ?? false
}

function quit(): void {
  go('menu')
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
      <p>Не удалось загрузить бой</p>
      <pre>{{ error }}</pre>
      <button class="btn" @click="quit">Главное меню</button>
    </div>
    <PauseMenu
      v-if="paused"
      :disconnected="disconnected"
      @resume="resume"
      @restart="restart"
      @quit="quit"
    />
  </div>
</template>

<style scoped>
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
