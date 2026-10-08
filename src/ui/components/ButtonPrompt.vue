<script setup lang="ts">
import type { PromptStyle } from '@/game/input/input-manager'

/**
 * On-screen prompt for a menu action, drawn as the real button of the device
 * the player is using: keyboard keycap, Xbox A/B or PlayStation ✕/○.
 */
const props = defineProps<{
  action: 'confirm' | 'back'
  device: PromptStyle
}>()

const GLYPH: Readonly<Record<PromptStyle, Readonly<Record<'confirm' | 'back', string>>>> = {
  keyboard: { confirm: 'Enter', back: 'Esc' },
  xbox: { confirm: 'A', back: 'B' },
  playstation: { confirm: '✕', back: '○' },
}

const label = (): string => GLYPH[props.device][props.action]
</script>

<template>
  <span class="prompt" :class="[device, action]">{{ label() }}</span>
</template>

<style scoped>
.prompt {
  display: inline-grid;
  place-items: center;
  min-width: 1.7cqw;
  height: 1.7cqw;
  font-size: 0.8cqw;
  line-height: 1;
  border: 0.2cqw solid currentColor;
  background: #0b0614;
}
/* gamepad face buttons are round */
.xbox,
.playstation {
  border-radius: 50%;
}
.xbox.confirm {
  color: #4fdc6a;
}
.xbox.back {
  color: #ff4f5e;
}
.playstation.confirm {
  color: #7da8ff;
  font-size: 0.95cqw;
}
.playstation.back {
  color: #ff6b9a;
  font-size: 1cqw;
}
/* keyboard keys are keycaps */
.keyboard {
  padding: 0 0.5cqw;
  border-radius: 0.3cqw;
  color: #fff;
  font-size: 0.6cqw;
  box-shadow: inset 0 -0.2cqw 0 rgba(255, 255, 255, 0.25);
}
</style>
