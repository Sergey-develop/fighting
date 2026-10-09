<script setup lang="ts">
import { computed, ref } from 'vue'
import { fighterAssetUrl } from '@/game/assets/atlas'
import { audioManager } from '@/game/audio/audio-manager'
import { PLAYER_SLOTS, type PlayerSlot } from '@/game/core/types'
import { getFighter } from '@/game/fighters/registry'
import { hasMenu } from '@/game/input/actions'
import FighterPreview from '../components/FighterPreview.vue'
import PixelNumber from '../components/PixelNumber.vue'
import { net } from '@/game/net/connection'
import { app, go, leaveOnline, online, onlineBackToSelect, requestRematch, statistics } from '../store'
import { useMenuInput } from '../use-menu-input'

const result = app.lastResult
const isOnline = app.mode === 'online'
const labels: [string, string] = app.mode === 'ai' ? ['PLAYER 1', 'AI'] : ['PLAYER 1', 'PLAYER 2']
if (isOnline) labels[net.localSlot] += ' (ВЫ)'

function rematch(): void {
  if (isOnline) requestRematch()
  else go('versus')
}

const items = isOnline
  ? [
      { label: 'Реванш', run: rematch },
      { label: 'Выбор персонажа', run: onlineBackToSelect },
      { label: 'Выйти', run: leaveOnline },
    ]
  : [
      { label: 'Реванш', run: rematch },
      { label: 'Выбор персонажа', run: () => go('select') },
      { label: 'Главное меню', run: () => go('menu') },
    ]

/** online: who already asked for the rematch */
const rematchNote = computed(() => {
  if (!isOnline) return ''
  if (online.status !== 'connected') return online.error || 'Соперник отключился'
  if (online.localRematch) return 'Ждём ответа соперника...'
  if (online.remoteRematch) return 'Соперник хочет реванш!'
  return ''
})
const focus = ref(0)

function activate(i: number): void {
  audioManager.play('ui-confirm')
  items[i]?.run()
}

useMenuInput(({ any }) => {
  if (hasMenu(any, 'left') || hasMenu(any, 'up')) focus.value = (focus.value + items.length - 1) % items.length
  if (hasMenu(any, 'right') || hasMenu(any, 'down')) focus.value = (focus.value + 1) % items.length
  if (hasMenu(any, 'confirm')) activate(focus.value)
})

function portrait(slot: PlayerSlot): string {
  const id = result?.fighters[slot] ?? app.selection[slot]
  const def = getFighter(id)
  const won = result?.winner === slot
  return fighterAssetUrl(def.assetDir, `portrait-${won ? def.portraits.normal : def.portraits.hurt}.webp`)
}
</script>

<template>
  <div class="screen dim result">
    <h1 v-if="result" class="title headline" :class="result.winner === 0 ? 'p1-color' : 'p2-color'">
      {{ labels[result.winner] }} WINS
    </h1>
    <div v-if="result" class="cards">
      <div
        v-for="slot in PLAYER_SLOTS"
        :key="slot"
        class="card panel"
        :class="[slot === 0 ? 'p1' : 'p2', { winner: result.winner === slot }]"
      >
        <div class="sprite">
          <FighterPreview :fighter-id="result.fighters[slot]" :pose="result.winner === slot ? 'win' : 'idle'" :flip="slot === 1" />
        </div>
        <img class="face" :src="portrait(slot)" alt="" draggable="false" />
        <div class="verdict">{{ result.winner === slot ? 'WIN!' : 'LOSE' }}</div>
        <div class="who">{{ labels[slot] }} · {{ getFighter(result.fighters[slot]).name }}</div>
        <div class="score"><PixelNumber :value="result.wins[slot]" /></div>
        <div class="sub">раундов выиграно</div>
      </div>
    </div>
    <div class="stats hint" v-if="isOnline">{{ rematchNote || `пинг ${online.ping} мс` }}</div>
    <div class="stats hint" v-else-if="result?.mode === 'ai'">
      Против AI: {{ statistics.vsAi.wins }} побед / {{ statistics.vsAi.losses }} поражений
    </div>
    <div class="stats hint" v-else>
      P1: {{ statistics.versus[0].wins }} W / {{ statistics.versus[0].losses }} L &nbsp;·&nbsp; P2:
      {{ statistics.versus[1].wins }} W / {{ statistics.versus[1].losses }} L
    </div>
    <div class="buttons">
      <button
        v-for="(item, i) in items"
        :key="item.label"
        class="btn"
        :class="{ focused: focus === i, pink: i === 0, ghost: i > 0 }"
        @mouseenter="focus = i"
        @click="activate(i)"
      >
        {{ item.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.result {
  justify-content: center;
  gap: 1.8cqw;
}
.headline {
  position: relative;
  font-size: 4.2cqw;
  margin: 0;
}
.cards {
  position: relative;
  display: flex;
  gap: 4cqw;
}
.card {
  width: 30cqw;
  padding: 1.5cqw;
  text-align: center;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-areas:
    'sprite face'
    'sprite verdict'
    'who who'
    'score score'
    'sub sub';
  align-items: center;
  gap: 0.6cqw;
}
.card.p1 {
  border-color: var(--p1);
}
.card.p2 {
  border-color: var(--p2);
}
.card:not(.winner) {
  filter: saturate(0.4) brightness(0.8);
}
.sprite {
  grid-area: sprite;
  height: 16cqw;
}
.face {
  grid-area: face;
  width: 7cqw;
  justify-self: center;
}
.verdict {
  grid-area: verdict;
  font-size: 2.6cqw;
}
.p1 .verdict,
.p1 .score {
  color: var(--p1);
}
.p2 .verdict,
.p2 .score {
  color: var(--p2);
}
.card:not(.winner) .verdict {
  color: #c9cbe0;
}
.who {
  grid-area: who;
  font-size: 0.8cqw;
}
.score {
  grid-area: score;
  font-size: 5cqw; /* digit height */
  line-height: 1;
}
.sub {
  grid-area: sub;
  font-size: 0.65cqw;
  color: var(--muted);
}
.stats {
  position: relative;
}
.buttons {
  position: relative;
  display: flex;
  gap: 1.5cqw;
}
</style>
