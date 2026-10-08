<script setup lang="ts">
import { computed } from 'vue'

/**
 * Renders a number with the game's pixel digit art (numbers.png, cut into
 * public/assets/ui/digits/N.webp). Height follows the parent's font-size
 * (1em), so it is sized like text. Non-digit characters stay text.
 */
const props = defineProps<{ value: number | string }>()

const BASE = `${import.meta.env.BASE_URL}assets/ui/digits/`
const chars = computed(() => String(props.value).split(''))

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}
</script>

<template>
  <span class="pixel-number" :aria-label="String(value)" role="img">
    <template v-for="(c, i) in chars" :key="i">
      <img v-if="isDigit(c)" class="digit" :src="`${BASE}${c}.webp`" alt="" draggable="false" />
      <span v-else class="char">{{ c }}</span>
    </template>
  </span>
</template>

<style scoped>
.pixel-number {
  display: inline-flex;
  align-items: flex-end;
  height: 1em;
  line-height: 1;
  vertical-align: bottom;
}
.digit {
  display: block;
  height: 100%;
  width: auto;
}
/* the art has thick outlines: let neighbouring digits overlap a little */
.digit + .digit {
  margin-left: -0.08em;
}
.char {
  font-size: 0.6em;
  margin: 0 0.1em 0.12em;
}
</style>
