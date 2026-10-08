<script setup lang="ts">
import { ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { hasMenu } from '@/game/input/actions'
import type { RoundTime } from '@/game/storage/records'
import { app, go, resetStatistics, settings } from '../store'
import { useMenuInput } from '../use-menu-input'

type VolumeKey = 'master' | 'music' | 'sfx'

interface Row {
  label: string
  value: () => string
  change: (dir: -1 | 1) => void
}

const ROUND_TIMES: readonly RoundTime[] = [30, 60, 99]
const confirmReset = ref(false)

function volume(key: VolumeKey, dir: -1 | 1): void {
  const a = settings.value.audio
  a[key] = Math.round(Math.min(1, Math.max(0, a[key] + dir * 0.1)) * 10) / 10
  audioManager.play('ui-move')
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

const rows: Row[] = [
  { label: 'Общая громкость', value: () => pct(settings.value.audio.master), change: (d) => volume('master', d) },
  { label: 'Музыка', value: () => pct(settings.value.audio.music), change: (d) => volume('music', d) },
  { label: 'Эффекты', value: () => pct(settings.value.audio.sfx), change: (d) => volume('sfx', d) },
  {
    label: 'Синтезированные звуки',
    value: () => (settings.value.audio.synthFallback ? 'Вкл' : 'Выкл'),
    change: () => {
      settings.value.audio.synthFallback = !settings.value.audio.synthFallback
    },
  },
  {
    label: 'Время раунда',
    value: () => `${settings.value.roundTimeSeconds} c`,
    change: (d) => {
      const i = ROUND_TIMES.indexOf(settings.value.roundTimeSeconds)
      const next = ROUND_TIMES[(i + d + ROUND_TIMES.length) % ROUND_TIMES.length]
      if (next) settings.value.roundTimeSeconds = next
    },
  },
  {
    label: 'Хитбоксы (отладка)',
    value: () => (settings.value.showHitboxes ? 'Вкл' : 'Выкл'),
    change: () => {
      settings.value.showHitboxes = !settings.value.showHitboxes
    },
  },
]

const focus = ref(0)
const total = rows.length + 2 // + reset stats + back

function back(): void {
  audioManager.play('ui-back')
  go(app.returnTo === 'settings' ? 'menu' : app.returnTo)
}

function reset(): void {
  if (!confirmReset.value) {
    confirmReset.value = true
    return
  }
  resetStatistics()
  confirmReset.value = false
  audioManager.play('ui-confirm')
}

function activate(i: number): void {
  if (i < rows.length) rows[i]?.change(1)
  else if (i === rows.length) reset()
  else back()
}

useMenuInput(({ any }) => {
  if (hasMenu(any, 'up')) focus.value = (focus.value + total - 1) % total
  if (hasMenu(any, 'down')) focus.value = (focus.value + 1) % total
  if (hasMenu(any, 'left')) rows[focus.value]?.change(-1)
  if (hasMenu(any, 'right')) rows[focus.value]?.change(1)
  if (hasMenu(any, 'confirm')) activate(focus.value)
  if (hasMenu(any, 'back')) back()
})
</script>

<template>
  <div class="screen dim settings">
    <h1 class="title head">НАСТРОЙКИ</h1>
    <div class="panel list">
      <div v-for="(row, i) in rows" :key="row.label" class="row" :class="{ focused: focus === i }" @mouseenter="focus = i">
        <span>{{ row.label }}</span>
        <span class="value">
          <button class="arrow" @click="row.change(-1)">◀</button>
          <b>{{ row.value() }}</b>
          <button class="arrow" @click="row.change(1)">▶</button>
        </span>
      </div>
      <button class="btn ghost" :class="{ focused: focus === rows.length }" @mouseenter="focus = rows.length" @click="reset">
        {{ confirmReset ? 'Точно сбросить?' : 'Сбросить статистику' }}
      </button>
      <button class="btn pink" :class="{ focused: focus === rows.length + 1 }" @mouseenter="focus = rows.length + 1" @click="back">
        Назад
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings {
  justify-content: center;
  gap: 2cqw;
}
.head {
  position: relative;
  margin: 0;
  font-size: 2.6cqw;
}
.list {
  position: relative;
  width: 50cqw;
  padding: 2cqw 2.5cqw;
  display: flex;
  flex-direction: column;
  gap: 0.8cqw;
  border-color: var(--p1);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.85cqw;
  padding: 0.7cqw 0.8cqw;
  border: 0.15cqw solid transparent;
}
.row.focused {
  border-color: #fff;
  background: rgba(255, 255, 255, 0.05);
}
.value {
  display: flex;
  align-items: center;
  gap: 1cqw;
}
.value b {
  min-width: 6cqw;
  text-align: center;
  color: var(--p1);
}
.arrow {
  font-family: var(--font);
  font-size: 0.8cqw;
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
}
</style>
