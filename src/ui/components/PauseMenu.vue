<script setup lang="ts">
import { computed, ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { hasMenu } from '@/game/input/actions'
import { inputManager, type PromptStyle } from '@/game/input/input-manager'
import { useMenuInput } from '../use-menu-input'
import ButtonPrompt from './ButtonPrompt.vue'
import LightningBolt from './LightningBolt.vue'

const props = defineProps<{
  disconnected: [boolean, boolean]
  /** online: the match keeps running behind the menu and can't be restarted */
  online?: boolean
}>()
const emit = defineEmits<{
  resume: []
  restart: []
  quit: []
}>()

const missing = computed(() => props.disconnected.findIndex((d) => d))
const items = computed(() =>
  props.online
    ? [
        { label: 'Continue', run: () => emit('resume'), disabled: false },
        { label: 'Exit', run: () => emit('quit'), disabled: false },
      ]
    : [
        { label: 'Continue', run: () => emit('resume'), disabled: missing.value >= 0 },
        { label: 'Restart', run: () => emit('restart'), disabled: false },
        { label: 'Exit', run: () => emit('quit'), disabled: false },
      ],
)
const focus = ref(0)
/** prompts follow the device that was pressed last */
const promptStyle = ref<PromptStyle>(inputManager.promptStyle)

function move(dir: 1 | -1): void {
  const n = items.value.length
  focus.value = (focus.value + dir + n) % n
  audioManager.play('ui-move')
}

function activate(i: number): void {
  const item = items.value[i]
  if (!item || item.disabled) return
  audioManager.play('ui-confirm')
  item.run()
}

useMenuInput(({ any }) => {
  if (inputManager.promptStyle !== promptStyle.value) promptStyle.value = inputManager.promptStyle
  if (hasMenu(any, 'up')) move(-1)
  if (hasMenu(any, 'down')) move(1)
  if (hasMenu(any, 'confirm')) activate(focus.value)
  if (hasMenu(any, 'back') && missing.value < 0) {
    audioManager.play('ui-back')
    emit('resume')
  }
})
</script>

<template>
  <div class="pause">
    <div class="heading">
      <LightningBolt class="bolt left" />
      <h2 class="title-text">PAUSE</h2>
      <LightningBolt class="bolt right" flip />
    </div>

    <p v-if="missing >= 0" class="warn">
      Контроллер игрока {{ missing + 1 }} отключён — подключите его, чтобы продолжить
    </p>

    <ul class="items">
      <li v-for="(item, i) in items" :key="item.label" class="row" :class="{ focused: focus === i }">
        <span class="arrow" aria-hidden="true">▶</span>
        <button
          class="item"
          :class="{ focused: focus === i }"
          :disabled="item.disabled"
          @mouseenter="focus = i"
          @click="activate(i)"
        >
          <span class="label">{{ item.label }}</span>
        </button>
      </li>
    </ul>

    <div class="legend">
      <ButtonPrompt action="confirm" :device="promptStyle" /> Select
      <ButtonPrompt class="gap" action="back" :device="promptStyle" /> Back
    </div>
  </div>
</template>

<style scoped>
.pause {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.6cqw;
  /* darken the frozen fight so the menu reads clearly; a bit deeper at the edges */
  background:
    radial-gradient(ellipse at center, rgba(10, 6, 28, 0.55) 0%, rgba(10, 6, 28, 0.85) 100%);
  backdrop-filter: blur(2px);
}
.heading {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 0.8cqw;
}
.title-text {
  margin: 0;
  font-size: 6.4cqw;
  line-height: 1;
  color: var(--p1);
  background: linear-gradient(180deg, #fff6a8 0%, var(--p1) 45%, var(--p1-deep) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0.3cqw 0.3cqw 0 var(--p2)) drop-shadow(0.35cqw 0.35cqw 0 var(--ink));
}
.bolt {
  width: 6.8cqw;
  height: 8.1cqw;
  flex: none;
  /* bolts sit a little low, their inner tips reaching past the title's baseline */
  margin-top: 2.2cqw;
}
.bolt.left {
  margin-right: -0.6cqw;
}
.bolt.right {
  margin-left: -0.6cqw;
}
.warn {
  margin: 0;
  font-size: 0.8cqw;
  color: #fff;
  background: var(--ink);
  padding: 0.6cqw 1.2cqw;
  border: 0.2cqw solid var(--p2);
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1.1cqw;
}
.row {
  display: flex;
  align-items: center;
  gap: 1cqw;
}
.arrow {
  width: 1.6cqw;
  font-size: 1.6cqw;
  color: #fff;
  opacity: 0;
  text-shadow: 0.15cqw 0.15cqw 0 var(--ink);
}
.row.focused .arrow {
  opacity: 1;
}
/* parallelogram buttons from the mock-up — skewed, not clipped */
.item {
  width: 24cqw;
  height: 4.4cqw;
  transform: skewX(-14deg);
  font-family: var(--font);
  font-size: 1.5cqw;
  text-transform: uppercase;
  color: #fff;
  background: linear-gradient(180deg, #1d2560, #0f1235);
  border: 0.3cqw solid var(--p1);
  box-shadow:
    0 0 0 0.2cqw var(--ink),
    inset 0 0 0 0.15cqw rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition:
    transform 0.08s ease,
    background 0.08s ease;
}
.item .label {
  display: inline-block;
  transform: skewX(14deg);
}
.item.focused {
  color: var(--ink);
  background: linear-gradient(180deg, #fff27a, var(--p1) 50%, var(--p1-deep));
  border-color: #fff6a8;
  box-shadow:
    0 0 0 0.2cqw var(--ink),
    0 0 1.4cqw rgba(255, 210, 31, 0.7);
  transform: skewX(-14deg) scale(1.04);
}
.item:disabled {
  opacity: 0.45;
  cursor: default;
}
.legend {
  margin-top: 0.6cqw;
  display: flex;
  align-items: center;
  gap: 0.6cqw;
  font-size: 0.85cqw;
  text-transform: uppercase;
  padding: 0.6cqw 1.4cqw;
  background: rgba(10, 6, 28, 0.75);
}
.legend .gap {
  margin-left: 1.6cqw;
}
@media (prefers-reduced-motion: reduce) {
  .item {
    transition: none;
  }
}
</style>
