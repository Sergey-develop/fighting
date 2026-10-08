<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadAtlas, type SpriteAtlas } from '@/game/assets/atlas'
import { getFighter } from '@/game/fighters/registry'
import type { LoopAnimation } from '@/game/fighters/types'

const props = defineProps<{
  fighterId: string
  /** which loop animation to show */
  pose: 'idle' | 'win' | 'intro'
  /** mirror (player 2 faces left) */
  flip?: boolean
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let atlas: SpriteAtlas | null = null
let raf = 0
let start = 0
let loadToken = 0

async function loadFor(id: string): Promise<void> {
  const token = ++loadToken
  const def = getFighter(id)
  const a = await loadAtlas(def.assetDir)
  if (token === loadToken) {
    atlas = a
    start = performance.now()
  }
}

function draw(now: number): void {
  raf = requestAnimationFrame(draw)
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx || !atlas) return
  const def = getFighter(props.fighterId)
  const anim: LoopAnimation = (props.pose === 'intro' ? def.animations.intro : def.animations[props.pose]) ?? def.animations.idle
  const tick = Math.floor(((now - start) / 1000) * 60)
  const n = anim.frames.length
  let i = Math.floor(tick / anim.ticksPerFrame)
  // non-looping poses hold the last frame for a moment, then restart
  i = anim.loop ? i % n : Math.min(i % (n + 6), n - 1)
  const fr = atlas.rows[anim.row - 1]?.[anim.frames[i] ?? 0]
  ctx.clearRect(0, 0, c.width, c.height)
  if (!fr) return
  const scale = Math.min((c.height * 0.95) / fr.h, (c.width * 0.95) / fr.w, 1.4)
  ctx.save()
  ctx.translate(c.width / 2, c.height - 4)
  ctx.scale(props.flip ? -scale : scale, scale)
  ctx.drawImage(atlas.image, fr.x, fr.y, fr.w, fr.h, -fr.ax, -fr.ay, fr.w, fr.h)
  ctx.restore()
}

watch(
  () => props.fighterId,
  (id) => void loadFor(id),
)

onMounted(() => {
  void loadFor(props.fighterId)
  raf = requestAnimationFrame(draw)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="canvas" class="preview" width="560" height="620" />
</template>

<style scoped>
.preview {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
