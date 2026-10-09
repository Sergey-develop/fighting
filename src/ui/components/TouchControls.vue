<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { ACTION_BIT, type InputAction } from '@/game/input/actions'
import { inputManager } from '@/game/input/input-manager'

const emit = defineEmits<{ pause: [] }>()

/** phones / tablets only: a mouse or keyboard player never sees the buttons */
const touch = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window)

interface Pad {
  action: InputAction
  label: string
  cls: string
}

const MOVE: Pad[] = [
  { action: 'left', label: '◀', cls: 'left' },
  { action: 'jump', label: '▲', cls: 'jump' },
  { action: 'right', label: '▶', cls: 'right' },
]

const ATTACKS: Pad[] = [
  { action: 'light', label: 'Удар', cls: 'light' },
  { action: 'heavy', label: 'Сильный', cls: 'heavy' },
  { action: 'kick', label: 'Нога', cls: 'kick' },
  { action: 'special', label: 'Супер', cls: 'special' },
  { action: 'block', label: 'Блок', cls: 'block' },
]

/** pointer id → action it holds, so every finger releases exactly what it pressed */
const held = new Map<number, InputAction>()

function down(e: PointerEvent, action: InputAction): void {
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  held.set(e.pointerId, action)
  inputManager.setTouch(ACTION_BIT[action], true)
}

function up(e: PointerEvent): void {
  const action = held.get(e.pointerId)
  if (!action) return
  held.delete(e.pointerId)
  // another finger may still hold the same button
  if (![...held.values()].includes(action)) inputManager.setTouch(ACTION_BIT[action], false)
}

onBeforeUnmount(() => {
  for (const action of held.values()) inputManager.setTouch(ACTION_BIT[action], false)
  held.clear()
})
</script>

<template>
  <div v-if="touch" class="touch" @contextmenu.prevent>
    <div class="cluster move">
      <button
        v-for="p in MOVE"
        :key="p.action"
        class="pad"
        :class="p.cls"
        @pointerdown="down($event, p.action)"
        @pointerup="up"
        @pointercancel="up"
        @lostpointercapture="up"
      >
        {{ p.label }}
      </button>
    </div>
    <div class="cluster attacks">
      <button
        v-for="p in ATTACKS"
        :key="p.action"
        class="pad"
        :class="p.cls"
        @pointerdown="down($event, p.action)"
        @pointerup="up"
        @pointercancel="up"
        @lostpointercapture="up"
      >
        {{ p.label }}
      </button>
    </div>
    <button class="pause-btn" @click="emit('pause')">❚❚</button>
  </div>
</template>

<style scoped>
.touch {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.pad,
.pause-btn {
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  font: inherit;
  color: #fff;
  border: 0.25cqw solid rgba(255, 255, 255, 0.55);
  background: rgba(20, 16, 51, 0.45);
  text-shadow: 0.15cqw 0.15cqw 0 #000;
  padding: 0;
}
.pad:active {
  background: rgba(255, 255, 255, 0.35);
}
.cluster {
  position: absolute;
  bottom: 3cqw;
  display: grid;
  gap: 1.2cqw;
}

/* ◀ ▲ ▶ — bottom left */
.move {
  left: 3cqw;
  grid-template-columns: repeat(3, 9cqw);
  grid-template-rows: 9cqw 9cqw;
  grid-template-areas:
    '. jump .'
    'left . right';
}
.move .pad {
  border-radius: 50%;
  font-size: 3cqw;
}
.move .left {
  grid-area: left;
}
.move .right {
  grid-area: right;
}
.move .jump {
  grid-area: jump;
}

/* attacks — bottom right, thumb arc */
.attacks {
  right: 3cqw;
  grid-template-columns: repeat(3, 9cqw);
  grid-template-rows: 9cqw 9cqw;
  grid-template-areas:
    'special heavy block'
    'kick light light';
}
.attacks .pad {
  border-radius: 1.5cqw;
  font-size: 1.1cqw;
}
.attacks .light {
  grid-area: light;
  border-color: var(--p1);
}
.attacks .heavy {
  grid-area: heavy;
  border-color: var(--p2);
}
.attacks .kick {
  grid-area: kick;
}
.attacks .special {
  grid-area: special;
  border-color: #6cf;
}
.attacks .block {
  grid-area: block;
  border-color: #9f9;
}

.pause-btn {
  position: absolute;
  top: 9cqw;
  left: 50%;
  transform: translateX(-50%);
  width: 5cqw;
  height: 5cqw;
  border-radius: 50%;
  font-size: 1.4cqw;
}
</style>
