<script setup lang="ts">
import { ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { hasMenu } from '@/game/input/actions'
import type { GameMode } from '@/game/fight-session'
import { app, go, openOptions, statistics } from '../store'
import { useMenuInput } from '../use-menu-input'

interface Item {
  label: string
  run: () => void
}

function startMode(mode: GameMode): void {
  app.mode = mode
  go('select')
}

const items: Item[] = [
  { label: 'Игрок против игрока', run: () => startMode('versus') },
  { label: 'Игрок против AI', run: () => startMode('ai') },
  { label: 'Управление', run: () => openOptions('controls') },
  { label: 'Настройки', run: () => openOptions('settings') },
]

const focus = ref(0)

function activate(i: number): void {
  focus.value = i
  audioManager.play('ui-confirm')
  items[i]?.run()
}

useMenuInput(({ any }) => {
  if (hasMenu(any, 'up')) {
    focus.value = (focus.value + items.length - 1) % items.length
    audioManager.play('ui-move')
  }
  if (hasMenu(any, 'down')) {
    focus.value = (focus.value + 1) % items.length
    audioManager.play('ui-move')
  }
  if (hasMenu(any, 'confirm')) activate(focus.value)
})
</script>

<template>
  <div class="screen dim menu">
    <h1 class="title logo">FIGHT!</h1>
    <div class="layout">
      <nav class="items">
        <button
          v-for="(item, i) in items"
          :key="item.label"
          class="btn"
          :class="{ focused: focus === i, pink: i % 2 === 1 }"
          @mouseenter="focus = i"
          @click="activate(i)"
        >
          {{ item.label }}
        </button>
      </nav>
      <section class="panel stats">
        <h2>Статистика</h2>
        <div class="row">
          <span>Против AI</span>
          <span><b class="p1-color">{{ statistics.vsAi.wins }}</b> W / <b class="p2-color">{{ statistics.vsAi.losses }}</b> L</span>
        </div>
        <div class="row">
          <span>Игрок 1</span>
          <span>{{ statistics.versus[0].wins }} W / {{ statistics.versus[0].losses }} L</span>
        </div>
        <div class="row">
          <span>Игрок 2</span>
          <span>{{ statistics.versus[1].wins }} W / {{ statistics.versus[1].losses }} L</span>
        </div>
      </section>
    </div>
    <p class="hint footer">↑↓ / W S / D-pad — выбор &nbsp;·&nbsp; Enter / J / A — подтвердить</p>
  </div>
</template>

<style scoped>
.menu {
  justify-content: center;
  gap: 3cqw;
}
.logo {
  position: relative;
  font-size: 7cqw;
  transform: rotate(-4deg);
  margin: 0;
}
.layout {
  position: relative;
  display: flex;
  gap: 4cqw;
  align-items: flex-start;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 1.2cqw;
}
.items .btn {
  min-width: 30cqw;
  text-align: left;
}
.stats {
  width: 28cqw;
  padding: 1.6cqw 2cqw;
  border-color: var(--p1);
}
.stats h2 {
  font-size: 1.2cqw;
  color: var(--p1);
  margin: 0 0 1.4cqw;
}
.row {
  display: flex;
  justify-content: space-between;
  font-size: 0.85cqw;
  padding: 0.7cqw 0;
  border-bottom: 0.15cqw dashed rgba(255, 255, 255, 0.15);
}
.footer {
  position: absolute;
  bottom: 2cqw;
}
</style>
