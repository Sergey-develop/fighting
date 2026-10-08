<script setup lang="ts">
import { computed } from 'vue'

/**
 * Angled plates from the mock-up (player tag, name, stat rows, button), drawn
 * as an SVG shape behind the content instead of clipping the element.
 */
type Shape = 'tag' | 'name' | 'stat' | 'button' | 'box'

const props = defineProps<{
  shape: Shape
  fill: string
  stroke: string
  /** mirror horizontally (player 2's side) */
  flip?: boolean
  /** dark offset shadow under the plate (buttons) */
  shadow?: boolean
}>()

const POINTS: Readonly<Record<Shape, string>> = {
  tag: '4,0 100,0 96,100 0,100',
  name: '3,0 100,0 97,100 0,100',
  stat: '5,0 100,0 100,100 5,100 0,50',
  button: '4,0 96,0 100,50 96,100 4,100 0,50',
  box: '4,0 100,0 100,100 0,100',
}

const points = computed(() => POINTS[props.shape])
const transform = computed(() => (props.flip ? 'translate(100 0) scale(-1 1)' : undefined))
</script>

<template>
  <span class="plate-root">
    <svg class="plate-bg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g :transform="transform">
        <polygon v-if="shadow" :points="points" fill="#0b0614" transform="translate(2.5 12)" />
        <polygon :points="points" fill="#0b0614" stroke="#0b0614" stroke-width="7" vector-effect="non-scaling-stroke" />
        <polygon :points="points" :fill="fill" :stroke="stroke" stroke-width="3" vector-effect="non-scaling-stroke" />
      </g>
    </svg>
    <span class="plate-content"><slot /></span>
  </span>
</template>

<style scoped>
.plate-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.plate-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.plate-content {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
  height: 100%;
}
</style>
