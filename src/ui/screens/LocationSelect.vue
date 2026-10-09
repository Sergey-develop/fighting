<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { hasMenu } from '@/game/input/actions'
import { LOCATIONS, isLocationLocked, sceneImageUrl, type LocationDefinition } from '@/game/locations/locations'
import { net } from '@/game/net/connection'
import { app, go, hostStartMatch, online, onlineBackToSelect } from '../store'
import { useMenuInput } from '../use-menu-input'

const n = LOCATIONS.length
const start = LOCATIONS.findIndex((l) => l.id === app.location)
const focus = ref(start >= 0 ? start : 0)
/** bumps to replay the "locked" shake */
const denied = ref(0)
/** direction of the last switch: new cards slide in from that side */
const dir = ref<1 | -1>(1)
/** confirmed: plays the "chosen" flash, then moves on */
const chosen = ref(false)
let leaveTimer = 0
onBeforeUnmount(() => window.clearTimeout(leaveTimer))

/** online: the host picks the arena, the guest watches the carousel */
const isOnline = app.mode === 'online'
const spectating = isOnline && online.role === 'guest'
if (isOnline && !spectating) watch(focus, (i) => net.send({ t: 'loc', i }), { immediate: true })
if (spectating) {
  watch(
    () => online.remoteLocation,
    (i) => {
      if (i === focus.value || i < 0 || i >= n) return
      const forward = (((i - focus.value) % n) + n) % n
      dir.value = forward <= n / 2 ? 1 : -1
      focus.value = i
      audioManager.play('ui-move')
    },
    { immediate: true },
  )
}

/** lightning frame drawn over every location card (border.png) */
const FRAME_ART = `${import.meta.env.BASE_URL}assets/ui/location-frame.webp`

/** placeholder art for locked cards: the default arena, darkened */
const placeholder = sceneImageUrl()

function at(offset: number): LocationDefinition {
  const l = LOCATIONS[(((focus.value + offset) % n) + n) % n]
  if (!l) throw new Error('no locations')
  return l
}

const current = computed(() => at(0))
const sides = computed(() => ({ left: [at(-2), at(-1)], right: [at(1), at(2)] }))

function move(step: 1 | -1): void {
  if (chosen.value || spectating) return
  dir.value = step
  focus.value = (((focus.value + step) % n) + n) % n
  audioManager.play('ui-move')
}

function pick(l: LocationDefinition): void {
  const i = LOCATIONS.indexOf(l)
  if (chosen.value || spectating) return
  if (i >= 0 && i !== focus.value) {
    // shortest way round the carousel decides the slide direction
    const forward = (((i - focus.value) % n) + n) % n
    dir.value = forward <= n / 2 ? 1 : -1
    focus.value = i
    audioManager.play('ui-move')
  }
}

function confirm(): void {
  if (spectating) return
  const l = current.value
  if (isLocationLocked(l)) {
    denied.value++
    audioManager.play('ui-back')
    return
  }
  if (chosen.value) return
  app.location = l.id
  audioManager.play('ui-confirm')
  chosen.value = true
  // let the "chosen" flash play before the VS screen
  leaveTimer = window.setTimeout(() => (isOnline ? hostStartMatch() : go('versus')), 420)
}

function back(): void {
  if (chosen.value) return
  audioManager.play('ui-back')
  if (isOnline) onlineBackToSelect()
  else go('select')
}

useMenuInput(({ any }) => {
  if (hasMenu(any, 'left')) move(-1)
  if (hasMenu(any, 'right')) move(1)
  if (hasMenu(any, 'confirm')) confirm()
  if (hasMenu(any, 'back')) back()
})
</script>

<template>
  <div class="screen locations" :class="{ 'from-left': dir === -1 }">
    <div v-if="chosen" class="chosen-flash" />
    <div class="heading">
      <svg class="burst" viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon
          points="100,0 112,22 140,4 136,28 172,14 158,38 198,36 170,52 196,70 160,66 172,92 138,76 128,100 108,80 92,100 82,78 50,96 58,70 6,76 34,54 2,36 42,38 26,12 64,26 66,2 88,22"
        />
      </svg>
      <h1 class="title-text">
        <span>Выберите</span>
        <span>локацию</span>
      </h1>
    </div>

    <div class="carousel">
      <div :key="`side-${focus}`" class="side slide">
        <button v-for="l in sides.left" :key="l.id" class="card small" :class="{ locked: isLocationLocked(l) }" @click="pick(l)">
          <span class="frame">
            <span class="window">
              <img :src="l.image ?? placeholder ?? ''" alt="" draggable="false" />
              <span v-if="isLocationLocked(l)" class="lock" aria-label="Закрыто">🔒</span>
            </span>
            <img class="frame-art" :src="FRAME_ART" alt="" draggable="false" />
          </span>
          <span class="plate">{{ l.name }}</span>
        </button>
      </div>

      <div
        :key="`big-${focus}-${denied}`"
        class="card big enter"
        :class="{ locked: isLocationLocked(current), shake: denied > 0, chosen }"
      >
        <span class="frame">
          <span class="window">
            <img :src="current.image ?? placeholder ?? ''" alt="" draggable="false" />
            <span v-if="isLocationLocked(current)" class="lock-big">
              <span class="lock-icon">🔒</span>
              <span>Скоро</span>
            </span>
          </span>
          <img class="frame-art" :src="FRAME_ART" alt="" draggable="false" />
        </span>
        <span class="plate">{{ current.name }}</span>
      </div>

      <div :key="`side-${focus}`" class="side slide">
        <button v-for="l in sides.right" :key="l.id" class="card small" :class="{ locked: isLocationLocked(l) }" @click="pick(l)">
          <span class="frame">
            <span class="window">
              <img :src="l.image ?? placeholder ?? ''" alt="" draggable="false" />
              <span v-if="isLocationLocked(l)" class="lock" aria-label="Закрыто">🔒</span>
            </span>
            <img class="frame-art" :src="FRAME_ART" alt="" draggable="false" />
          </span>
          <span class="plate">{{ l.name }}</span>
        </button>
      </div>
    </div>

    <p v-if="spectating" class="hint waiting">Соперник выбирает локацию...</p>
    <div v-else class="actions">
      <button class="arrow" aria-label="Предыдущая" @click="move(-1)">◀</button>
      <button class="btn pink" :disabled="isLocationLocked(current)" @click="confirm">
        {{ isLocationLocked(current) ? 'Закрыто' : 'Выбрать' }}
      </button>
      <button class="arrow" aria-label="Следующая" @click="move(1)">▶</button>
    </div>
    <button v-if="!spectating" class="btn ghost back" @click="back">Назад</button>
  </div>
</template>

<style scoped>
.waiting {
  position: relative;
  font-size: 1cqw;
}
.locations {
  justify-content: center;
  gap: 1.6cqw;
  background: rgba(10, 6, 28, 0.45);
}

/* ------------------------------------------------------------- heading */
.heading {
  position: relative;
  display: grid;
  place-items: center;
  margin-bottom: 0.5cqw;
}
.burst {
  position: absolute;
  width: 46cqw;
  height: 17cqw;
  fill: #fff27a;
  stroke: var(--p2);
  stroke-width: 1.4;
  filter: drop-shadow(0 0 1cqw rgba(255, 46, 154, 0.7));
}
.title-text {
  position: relative;
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.05;
  font-size: 3.6cqw;
  text-transform: uppercase;
  transform: rotate(-4deg) skewX(-8deg);
}
.title-text span {
  background: linear-gradient(180deg, #fff6a0 0%, var(--p1) 45%, #ff8a1a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0.22cqw 0 0 var(--p2)) drop-shadow(-0.22cqw 0 0 var(--p2)) drop-shadow(0 0.22cqw 0 var(--p2))
    drop-shadow(0 -0.22cqw 0 var(--p2)) drop-shadow(0.35cqw 0.35cqw 0 var(--ink));
}
.title-text span:last-child {
  font-size: 4.6cqw;
}

/* ------------------------------------------------------------ carousel */
.carousel {
  display: flex;
  align-items: center;
  gap: 2cqw;
  margin-top: 6cqw;
}
.side {
  display: flex;
  gap: 1.2cqw;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6cqw;
  padding: 0;
  background: none;
  border: 0;
  font-family: var(--font);
  color: #fff;
  cursor: pointer;
}
/*
 * Card = the lightning frame art (16:9). The location picture sits in the
 * frame's window, cut to its slightly skewed quad; the art is drawn on top,
 * so its halftone corners and spikes overlap the picture.
 */
.frame {
  position: relative;
  display: block;
}
.window {
  position: absolute;
  left: 8.85%;
  top: 14.88%;
  width: 81.34%;
  height: 68.86%;
  overflow: hidden;
  background: #0b0a22;
  clip-path: polygon(2.2% 0, 100% 0.8%, 97.8% 99.5%, 0 100%);
}
.window img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.frame-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.plate {
  display: block;
  background: var(--ink);
  border: 0.25cqw solid var(--p2);
  box-shadow: 0 0 0.8cqw rgba(255, 46, 154, 0.6);
  text-transform: uppercase;
  text-align: center;
  white-space: nowrap;
}

.card.small .frame {
  width: 13cqw;
  height: 7.32cqw;
}
.card.small .plate {
  font-size: 0.65cqw;
  padding: 0.45cqw 1cqw;
  min-width: 12cqw;
}
.card.small:hover .frame-art {
  filter: brightness(1.25) drop-shadow(0 0 0.8cqw rgba(255, 46, 154, 0.8));
}

.card.big {
  cursor: default;
}
.card.big .frame {
  width: 40cqw;
  height: 22.5cqw;
  filter: drop-shadow(0 0 1.2cqw rgba(255, 46, 154, 0.55));
}
.card.big .plate {
  margin-top: -1.2cqw;
  font-size: 2cqw;
  padding: 1cqw 4cqw;
  min-width: 36cqw;
  border-width: 0.4cqw;
  position: relative;
  z-index: 1;
}
.card.big.shake {
  animation: shake 0.3s ease;
}

/* -------------------------------------------------------------- locked */
.card.locked .window img {
  filter: grayscale(1) brightness(0.35) blur(1px);
}
.card.locked .frame-art {
  filter: grayscale(0.9) brightness(0.6);
}
.card.big.locked .frame {
  filter: none;
}
.card.locked .plate {
  border-color: #6b5a8a;
  color: #b9addb;
  box-shadow: none;
}
.lock {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 2cqw;
  filter: grayscale(0.2);
}
.lock-big {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8cqw;
  font-size: 1.6cqw;
  text-transform: uppercase;
  color: #e6dcff;
  text-shadow: 0.2cqw 0.2cqw 0 var(--ink);
}
.lock-icon {
  font-size: 4.5cqw;
}

/* ------------------------------------------------------------- actions */
.actions {
  display: flex;
  align-items: center;
  gap: 1.5cqw;
  margin-top: 0.8cqw;
}
.arrow {
  font-family: var(--font);
  font-size: 1.6cqw;
  color: var(--p2);
  background: none;
  border: 0;
  cursor: pointer;
  text-shadow: 0 0 0.8cqw rgba(255, 46, 154, 0.8);
}
.back {
  position: absolute;
  left: 1.2cqw;
  bottom: 1.2cqw;
  min-width: 0;
  font-size: 0.8cqw;
  padding: 0.7cqw 1.4cqw;
}
@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-1cqw);
  }
  75% {
    transform: translateX(1cqw);
  }
}
@media (prefers-reduced-motion: reduce) {
  .card.big.shake {
    animation: none;
  }
}
/* ------------------------------------------------------------ switching */
.locations {
  --dir: 1;
}
.locations.from-left {
  --dir: -1;
}
/* the big card flies in from the side we are scrolling towards */
.card.big.enter .frame {
  animation: big-in 0.38s cubic-bezier(0.2, 1.35, 0.4, 1);
}
.card.big.enter .plate {
  animation: plate-in 0.32s cubic-bezier(0.2, 1.8, 0.4, 1) 0.08s both;
}
/* small cards glide over */
.side.slide {
  animation: side-in 0.3s ease-out;
}
/* the burst behind the title breathes */
.burst {
  animation: burst-breathe 1.6s ease-in-out infinite alternate;
}
/* confirmed */
.card.big.chosen .frame {
  animation: chosen-pulse 0.42s ease-out forwards;
}
.chosen-flash {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: #fff;
  pointer-events: none;
  animation: flash-out 0.42s ease-out forwards;
}

@keyframes big-in {
  0% {
    opacity: 0;
    transform: translateX(calc(var(--dir) * 30%)) rotate(calc(var(--dir) * 6deg)) scale(0.82);
    filter: brightness(2.6);
  }
  60% {
    opacity: 1;
    filter: brightness(1.3);
  }
  100% {
    transform: none;
    filter: none;
  }
}
@keyframes plate-in {
  0% {
    opacity: 0;
    transform: scale(1.6);
  }
  100% {
    opacity: 1;
    transform: none;
  }
}
@keyframes side-in {
  from {
    opacity: 0.2;
    transform: translateX(calc(var(--dir) * 4cqw));
  }
}
@keyframes burst-breathe {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.05);
  }
}
@keyframes chosen-pulse {
  0% {
    transform: scale(1);
    filter: brightness(1);
  }
  35% {
    transform: scale(1.08);
    filter: brightness(1.9);
  }
  100% {
    transform: scale(1.04);
    filter: brightness(1.2);
  }
}
@keyframes flash-out {
  0% {
    opacity: 0;
  }
  30% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .card.big.enter .frame,
  .card.big.enter .plate,
  .side.slide,
  .burst,
  .card.big.chosen .frame,
  .chosen-flash {
    animation: none;
  }
}
</style>
