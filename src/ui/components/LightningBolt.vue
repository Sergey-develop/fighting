<script setup lang="ts">
import { useId } from 'vue'

/**
 * Lightning bolt from the PAUSE mock-up: two-segment zigzag, thick black
 * outline, yellow→orange body with white glints, warm glow. Drawn pointing
 * down-right (left of a title); `flip` mirrors it for the right side.
 */
defineProps<{ flip?: boolean }>()

const uid = useId()
const bodyId = `bolt-body-${uid}`
const shadeId = `bolt-shade-${uid}`
const glintId = `bolt-glint-${uid}`

// silhouette traced from the mock-up (viewBox units)
const SHAPE = 'M76 86 L193 185 L262 246 L208 284 L402 494 L184 384 L178 364 L96 294 L158 243 Z'
</script>

<template>
  <svg class="bolt" :class="{ flip }" viewBox="20 30 420 500" aria-hidden="true">
    <defs>
      <linearGradient :id="bodyId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff6a0" />
        <stop offset="0.35" stop-color="#ffe23a" />
        <stop offset="0.7" stop-color="#ffc414" />
        <stop offset="1" stop-color="#f08a00" />
      </linearGradient>
      <!-- darker rim on the lower/outer side of each segment -->
      <linearGradient :id="shadeId" x1="1" y1="0" x2="0" y2="0">
        <stop offset="0" stop-color="#e07a00" stop-opacity="0.55" />
        <stop offset="0.5" stop-color="#e07a00" stop-opacity="0" />
      </linearGradient>
      <filter :id="glintId" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
    </defs>

    <!-- outer glow + black outline -->
    <path :d="SHAPE" class="glow" />
    <path :d="SHAPE" class="outline" />
    <!-- body -->
    <path :d="SHAPE" :fill="`url(#${bodyId})`" />
    <path :d="SHAPE" :fill="`url(#${shadeId})`" />
    <!-- white glints along the centre of each segment and across the zig -->
    <g :filter="`url(#${glintId})`" class="glints">
      <path d="M100 120 L200 228" />
      <path d="M214 250 L132 290" />
      <path d="M204 330 L322 430" />
    </g>
    <g class="glints sharp">
      <path d="M104 126 L196 226" />
      <path d="M206 254 L140 288" />
    </g>
  </svg>
</template>

<style scoped>
.bolt {
  display: block;
  overflow: visible;
}
.bolt.flip {
  transform: scaleX(-1);
}
.glow {
  fill: none;
  stroke: #ffd21f;
  stroke-width: 34;
  stroke-linejoin: miter;
  opacity: 0.35;
  filter: blur(6px);
}
.outline {
  fill: #0b0614;
  stroke: #0b0614;
  stroke-width: 22;
  stroke-linejoin: miter;
  stroke-miterlimit: 10;
}
.glints path {
  fill: none;
  stroke: #ffffff;
  stroke-width: 10;
  stroke-linecap: round;
  opacity: 0.85;
}
.glints.sharp path {
  stroke-width: 3;
  opacity: 0.95;
}
</style>
