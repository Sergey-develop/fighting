<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { PLAYER_SLOTS } from '@/game/core/types'
import { getFighter } from '@/game/fighters/registry'
import { hasMenu } from '@/game/input/actions'
import FighterPreview from '../components/FighterPreview.vue'
import PixelNumber from '../components/PixelNumber.vue'
import { net } from '@/game/net/connection'
import { app, go } from '../store'
import { useMenuInput } from '../use-menu-input'

/** time for the slide-in + VS slam before the countdown starts */
const INTRO_MS = 1200
/** duration of each countdown number */
const STEP_MS = 1000
const COUNT_FROM = 3

const isOnline = app.mode === 'online'
const labels: [string, string] = app.mode === 'ai' ? ['PLAYER 1', 'AI'] : ['PLAYER 1', 'PLAYER 2']
if (isOnline) labels[net.localSlot] += ' · ВЫ'
const defs = [getFighter(app.selection[0]), getFighter(app.selection[1])] as const

/** 0 = countdown not started yet */
const count = ref(0)
let timer = 0
let done = false

function proceed(): void {
  if (done) return
  done = true
  window.clearTimeout(timer)
  app.fightSerial++
  go('fight') // the fight session crossfades from the VS track into the fight music
}

function tick(n: number): void {
  if (done) return
  if (n === 0) {
    proceed()
    return
  }
  count.value = n
  audioManager.play('round')
  timer = window.setTimeout(() => tick(n - 1), STEP_MS)
}

onMounted(() => {
  audioManager.playMusic('vs', { loop: false })
  timer = window.setTimeout(() => tick(COUNT_FROM), INTRO_MS)
})

onBeforeUnmount(() => window.clearTimeout(timer))

// online both sides must reach the fight together, so the intro can't be skipped
useMenuInput(({ any }) => {
  if (!isOnline && hasMenu(any, 'confirm')) proceed()
})
</script>

<template>
  <div class="screen versus" @click="!isOnline && proceed()">
    <div v-for="slot in PLAYER_SLOTS" :key="slot" class="side" :class="slot === 0 ? 'p1' : 'p2'">
      <div class="tag">{{ labels[slot] }}</div>
      <div class="sprite">
        <FighterPreview :fighter-id="defs[slot].id" pose="idle" :flip="slot === 1" />
      </div>
      <div class="name">{{ defs[slot].name }}</div>
      <div class="archetype">{{ defs[slot].profile.archetype }}</div>
    </div>
    <div class="slash" />
    <div class="vs title">VS</div>
    <div v-if="count > 0" :key="count" class="count"><PixelNumber :value="count" /></div>
    <p v-if="!isOnline" class="hint skip">Enter / A — пропустить</p>
  </div>
</template>

<style scoped>
.versus {
  flex-direction: row;
  cursor: pointer;
}
.side {
  position: relative;
  width: 50%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1cqw;
}
.side.p1 {
  background: linear-gradient(115deg, rgba(255, 210, 31, 0.6), rgba(18, 10, 36, 0.75) 70%);
  animation: in-left 0.45s cubic-bezier(0.2, 1, 0.3, 1) both;
}
.side.p2 {
  background: linear-gradient(245deg, rgba(255, 46, 154, 0.6), rgba(18, 10, 36, 0.75) 70%);
  animation: in-right 0.45s cubic-bezier(0.2, 1, 0.3, 1) both;
}
.tag {
  font-size: 1.6cqw;
  padding: 0.7cqw 3cqw;
  background: var(--ink);
  clip-path: polygon(1cqw 0, calc(100% - 1cqw) 0, 100% 50%, calc(100% - 1cqw) 100%, 1cqw 100%, 0 50%);
}
.p1 .tag,
.p1 .name {
  color: var(--p1);
}
.p2 .tag,
.p2 .name {
  color: var(--p2);
}
.sprite {
  width: 26cqw;
  height: 30cqw;
}
.name {
  font-size: 2.6cqw;
  text-shadow: 0.3cqw 0.3cqw 0 var(--ink);
}
.archetype {
  font-size: 0.9cqw;
  color: #fff;
  text-shadow: 0.15cqw 0.15cqw 0 var(--ink);
}
.slash {
  position: absolute;
  left: 50%;
  top: -10%;
  bottom: -10%;
  width: 0.5cqw;
  transform: translateX(-50%) rotate(8deg);
  background: linear-gradient(180deg, #fff, var(--p1), var(--p2), #fff);
  box-shadow: 0 0 2cqw #fff;
}
.vs {
  position: absolute;
  top: 50%;
  left: 50%;
  font-size: 9cqw;
  transform: translate(-50%, -50%) rotate(-6deg);
  animation: slam 0.5s 0.3s cubic-bezier(0.2, 1.8, 0.4, 1) both;
}
.count {
  position: absolute;
  top: 72%;
  left: 50%;
  font-size: 9cqw; /* digit height */
  line-height: 1;
  transform: translate(-50%, -50%);
  animation: count 0.4s cubic-bezier(0.2, 1.8, 0.4, 1) both;
}
.skip {
  position: absolute;
  bottom: 1.5cqw;
  left: 50%;
  transform: translateX(-50%);
}
@keyframes in-left {
  from {
    transform: translateX(-30%);
    opacity: 0;
  }
}
@keyframes in-right {
  from {
    transform: translateX(30%);
    opacity: 0;
  }
}
@keyframes count {
  from {
    transform: translate(-50%, -50%) scale(2.2);
    opacity: 0;
  }
}
@keyframes slam {
  from {
    transform: translate(-50%, -50%) rotate(-6deg) scale(3);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .side.p1,
  .side.p2,
  .vs,
  .count {
    animation-duration: 0.01s;
  }
}
</style>
