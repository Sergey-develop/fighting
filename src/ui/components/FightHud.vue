<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { fighterAssetUrl } from '@/game/assets/atlas'
import type { HudBridge, HudFighter, HudSnapshot, PortraitMood } from '@/game/bridge/hud-bridge'
import { PLAYER_SLOTS, type PlayerSlot } from '@/game/core/types'
import { getFighter } from '@/game/fighters/registry'
import PixelNumber from './PixelNumber.vue'

const props = defineProps<{
  bridge: HudBridge
  fighterIds: [string, string]
  labels: [string, string]
}>()

/**
 * DOM is updated imperatively from the bridge (once per rendered frame, only
 * when a value changed) — no Vue reactivity on 60 Hz data.
 */
interface SideRefs {
  hp: HTMLElement | null
  hpTrail: HTMLElement | null
  energy: HTMLElement | null
  portrait: HTMLImageElement | null
  combo: HTMLElement | null
  comboName: HTMLElement | null
  callout: HTMLElement | null
  wins: HTMLElement | null
}

function blankRefs(): SideRefs {
  return {
    hp: null,
    hpTrail: null,
    energy: null,
    portrait: null,
    combo: null,
    comboName: null,
    callout: null,
    wins: null,
  }
}

const sides: [SideRefs, SideRefs] = [blankRefs(), blankRefs()]
/* digits change at most once a second / once per hit: plain reactivity is fine */
const timerText = ref('60')
const timerLow = ref(false)
const comboNums = reactive([
  { hits: 0, damage: 0 },
  { hits: 0, damage: 0 },
])
const roundEl = ref<HTMLElement | null>(null)
const announceEl = ref<HTMLElement | null>(null)
const announceSubEl = ref<HTMLElement | null>(null)

interface SideCache {
  hp: number
  trail: number
  trailDelay: number
  energy: number
  mood: PortraitMood | ''
  comboKey: string
  comboVisible: boolean
  wins: number
  denied: number
  finisher: number
  guardBreak: number
  calloutTimer: number
}

function blankCache(): SideCache {
  return {
    hp: -1,
    trail: 1,
    trailDelay: 0,
    energy: -1,
    mood: '',
    comboKey: '',
    comboVisible: false,
    wins: -1,
    denied: 0,
    finisher: 0,
    guardBreak: 0,
    calloutTimer: 0,
  }
}

const cache: [SideCache, SideCache] = [blankCache(), blankCache()]
let lastTimer = -1
let lastPhaseSerial = -1
let lastRound = -1

const defs = [getFighter(props.fighterIds[0]), getFighter(props.fighterIds[1])] as const
const portraitUrl = (slot: PlayerSlot, mood: PortraitMood): string => {
  const d = defs[slot]
  return fighterAssetUrl(d.assetDir, `portrait-${d.portraits[mood]}.webp`)
}
const specialMarker = (slot: PlayerSlot): string => {
  const max = props.bridge.snapshot.fighters[slot].energyMax
  return `${(defs[slot].special.energyCost / max) * 100}%`
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text
}

function callout(slot: PlayerSlot, text: string): void {
  const el = sides[slot].callout
  if (!el) return
  el.textContent = text
  el.classList.remove('show')
  void el.offsetWidth // restart the CSS animation
  el.classList.add('show')
}

function updateSide(slot: PlayerSlot, f: HudFighter): void {
  const r = sides[slot]
  const c = cache[slot]
  const hp = Math.max(0, f.hp / f.maxHp)
  if (hp !== c.hp) {
    if (hp < c.hp) c.trailDelay = 30
    c.hp = hp
    if (r.hp) r.hp.style.transform = `scaleX(${hp})`
  }
  // the white "damage trail" catches up after a short delay
  if (c.trail > hp) {
    if (c.trailDelay > 0) c.trailDelay--
    else c.trail = Math.max(hp, c.trail - 0.008)
    if (r.hpTrail) r.hpTrail.style.transform = `scaleX(${c.trail})`
  } else if (c.trail < hp) {
    c.trail = hp
    if (r.hpTrail) r.hpTrail.style.transform = `scaleX(${hp})`
  }
  const en = Math.floor((f.energy / f.energyMax) * 200) / 200
  if (en !== c.energy) {
    c.energy = en
    if (r.energy) {
      r.energy.style.transform = `scaleX(${en})`
      r.energy.classList.toggle('charged', f.energy >= f.specialCost)
    }
  }
  if (f.mood !== c.mood) {
    c.mood = f.mood
    if (r.portrait) r.portrait.src = portraitUrl(slot, f.mood)
  }
  if (f.wins !== c.wins) {
    c.wins = f.wins
    r.wins?.querySelectorAll('.pip').forEach((pip, i) => pip.classList.toggle('won', i < f.wins))
  }
  const visible = f.comboHits >= 2
  if (visible !== c.comboVisible) {
    c.comboVisible = visible
    r.combo?.classList.toggle('show', visible)
  }
  if (visible) {
    const key = `${f.comboHits}|${f.comboDamage}|${f.comboName}`
    if (key !== c.comboKey) {
      c.comboKey = key
      const nums = comboNums[slot]
      if (nums) {
        nums.hits = f.comboHits
        nums.damage = f.comboDamage
      }
      setText(r.comboName, f.comboName)
      r.combo?.classList.remove('bump')
      void r.combo?.offsetWidth
      r.combo?.classList.add('bump')
    }
  }
  if (f.energyDeniedSerial !== c.denied) {
    c.denied = f.energyDeniedSerial
    callout(slot, 'Мало энергии')
  }
  if (f.guardBreakSerial !== c.guardBreak) {
    c.guardBreak = f.guardBreakSerial
    callout(slot, 'Блок пробит!')
  }
  if (f.comboFinisherSerial !== c.finisher) {
    c.finisher = f.comboFinisherSerial
    if (f.comboName) callout(slot, f.comboName)
  }
}

function announce(s: HudSnapshot): void {
  const main = announceEl.value
  const sub = announceSubEl.value
  if (!main || !sub) return
  let text = ''
  let small = ''
  switch (s.phase) {
    case 'READY': {
      const final = s.fighters[0].wins === s.roundsToWin - 1 && s.fighters[1].wins === s.roundsToWin - 1
      text = final ? 'ФИНАЛ' : `ROUND ${s.round}`
      small = 'READY'
      break
    }
    case 'FIGHT_TEXT':
      text = 'FIGHT!'
      break
    case 'KO':
      text = 'K.O.'
      break
    case 'TIME_OVER':
      text = 'TIME'
      break
    case 'ROUND_END':
      if (s.roundResult === 'draw' || s.roundResult === null) text = 'НИЧЬЯ'
      else {
        text = `${props.labels[s.roundResult]}`
        small = `${s.fighters[s.roundResult].name} берёт раунд`
      }
      break
    case 'MATCH_END':
      text = s.matchWinner === null ? '' : `${props.labels[s.matchWinner]} WINS`
      break
    case 'FIGHTING':
      break
  }
  main.textContent = text
  sub.textContent = small
  main.className = 'announce-main'
  if (s.phase === 'ROUND_END' || s.phase === 'MATCH_END') {
    const w = s.phase === 'MATCH_END' ? s.matchWinner : s.roundResult
    if (w === 0) main.classList.add('p1')
    if (w === 1) main.classList.add('p2')
  }
  if (text) {
    void main.offsetWidth
    main.classList.add('show')
  }
}

function update(s: HudSnapshot): void {
  for (const slot of PLAYER_SLOTS) updateSide(slot, s.fighters[slot])
  if (s.timer !== lastTimer) {
    lastTimer = s.timer
    timerText.value = String(s.timer).padStart(2, '0')
    timerLow.value = s.timer <= 10
  }
  if (s.round !== lastRound) {
    lastRound = s.round
    setText(roundEl.value, `ROUND ${s.round}`)
  }
  if (s.phaseSerial !== lastPhaseSerial) {
    lastPhaseSerial = s.phaseSerial
    announce(s)
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = props.bridge.subscribe(update)
})
onBeforeUnmount(() => unsubscribe?.())

const pips = Array.from({ length: props.bridge.snapshot.roundsToWin }, (_, i) => i)
</script>

<template>
  <div class="hud">
    <div v-for="slot in PLAYER_SLOTS" :key="slot" class="side" :class="slot === 0 ? 'p1' : 'p2'">
      <div class="portrait-frame">
        <img :ref="(el) => (sides[slot].portrait = el as HTMLImageElement | null)" :src="portraitUrl(slot, 'normal')" alt="" draggable="false" />
      </div>
      <div class="bars">
        <div class="tag-row">
          <span class="tag">{{ labels[slot] }}</span>
          <span :ref="(el) => (sides[slot].wins = el as HTMLElement | null)" class="wins">
            <i v-for="p in pips" :key="p" class="pip" />
          </span>
        </div>
        <div class="hp">
          <div :ref="(el) => (sides[slot].hpTrail = el as HTMLElement | null)" class="hp-trail" />
          <div :ref="(el) => (sides[slot].hp = el as HTMLElement | null)" class="hp-fill" />
        </div>
        <div class="name">{{ defs[slot].name }}</div>
        <div class="energy">
          <div :ref="(el) => (sides[slot].energy = el as HTMLElement | null)" class="energy-fill" />
          <div class="energy-mark" :style="{ left: slot === 0 ? specialMarker(slot) : 'auto', right: slot === 1 ? specialMarker(slot) : 'auto' }" />
          <span class="energy-label">ENERGY</span>
        </div>
      </div>
      <div :ref="(el) => (sides[slot].combo = el as HTMLElement | null)" class="combo">
        <div class="combo-hits"><span class="combo-word">COMBO x</span><PixelNumber :value="comboNums[slot]?.hits ?? 0" /></div>
        <div class="combo-damage"><PixelNumber :value="comboNums[slot]?.damage ?? 0" /><span class="combo-word">DAMAGE</span></div>
        <div :ref="(el) => (sides[slot].comboName = el as HTMLElement | null)" class="combo-name" />
      </div>
      <div :ref="(el) => (sides[slot].callout = el as HTMLElement | null)" class="callout" />
    </div>

    <div class="center">
      <div class="timer" :class="{ low: timerLow }"><PixelNumber :value="timerText" /></div>
      <div ref="roundEl" class="round">ROUND 1</div>
    </div>

    <div class="announce">
      <div ref="announceEl" class="announce-main" />
      <div ref="announceSubEl" class="announce-sub" />
    </div>
  </div>
</template>

<style scoped>
.hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.side {
  position: absolute;
  top: 1.4cqw;
  width: 42cqw;
  display: flex;
  gap: 1cqw;
}
.side.p1 {
  left: 1.4cqw;
}
.side.p2 {
  right: 1.4cqw;
  flex-direction: row-reverse;
}
.portrait-frame {
  width: 7.5cqw;
  height: 7.5cqw;
  flex: none;
  background: var(--ink);
  border: 0.35cqw solid var(--p1);
  clip-path: polygon(15% 0, 100% 0, 100% 85%, 85% 100%, 0 100%, 0 15%);
  overflow: hidden;
}
.p2 .portrait-frame {
  border-color: var(--p2);
}
.portrait-frame img {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0.25cqw;
  box-sizing: border-box;
  object-fit: contain;
}
.bars {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.45cqw;
}
.tag-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.p2 .tag-row {
  flex-direction: row-reverse;
}
.tag {
  font-size: 0.8cqw;
  padding: 0.35cqw 1.2cqw;
  background: var(--ink);
  border: 0.2cqw solid var(--p1);
  color: var(--p1);
}
.p2 .tag {
  border-color: var(--p2);
  color: var(--p2);
}
.wins {
  display: flex;
  gap: 0.5cqw;
}
.pip {
  width: 1.1cqw;
  height: 1.1cqw;
  background: var(--ink);
  border: 0.2cqw solid rgba(255, 255, 255, 0.6);
  transform: rotate(45deg);
}
.p1 .pip.won {
  background: var(--p1);
  border-color: #fff;
}
.p2 .pip.won {
  background: var(--p2);
  border-color: #fff;
}
.hp,
.energy {
  position: relative;
  background: var(--ink);
  border: 0.25cqw solid var(--ink);
  outline: 0.2cqw solid var(--p1);
  overflow: hidden;
}
.p2 .hp,
.p2 .energy {
  outline-color: var(--p2);
}
.hp {
  height: 2cqw;
  clip-path: polygon(0 0, 100% 0, calc(100% - 1cqw) 100%, 0 100%);
}
.p2 .hp {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 1cqw 100%);
}
.hp-fill,
.hp-trail,
.energy-fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  will-change: transform;
}
.p2 .hp-fill,
.p2 .hp-trail,
.p2 .energy-fill {
  transform-origin: right center;
}
.hp-trail {
  background: #fff;
}
.p1 .hp-fill {
  background: linear-gradient(180deg, #fff27a, var(--p1) 45%, var(--p1-deep));
}
.p2 .hp-fill {
  background: linear-gradient(180deg, #ff9ccf, var(--p2) 45%, var(--p2-deep));
}
.name {
  font-size: 0.85cqw;
  color: #fff;
  text-shadow: 0.15cqw 0.15cqw 0 var(--ink);
}
.p2 .name {
  text-align: right;
}
.energy {
  height: 1cqw;
  width: 70%;
}
.p2 .energy {
  align-self: flex-end;
}
.energy-fill {
  background: repeating-linear-gradient(90deg, var(--cyan) 0 1.2cqw, #2a8fbf 1.2cqw 1.35cqw);
}
.energy-fill.charged {
  background: repeating-linear-gradient(90deg, #fff 0 1.2cqw, var(--cyan) 1.2cqw 1.35cqw);
  animation: glow 0.6s ease-in-out infinite alternate;
}
.energy-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0.2cqw;
  background: #fff;
  opacity: 0.8;
}
.energy-label {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.5cqw;
  left: 0.5cqw;
  color: rgba(255, 255, 255, 0.75);
}
.p2 .energy-label {
  left: auto;
  right: 0.5cqw;
}
.center {
  position: absolute;
  top: 1cqw;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
}
.timer {
  /* height of the pixel digits */
  font-size: 4.6cqw;
  display: flex;
  justify-content: center;
}
.timer.low {
  animation: blink-digits 0.5s steps(2) infinite;
}
@keyframes blink-digits {
  50% {
    filter: hue-rotate(-50deg) brightness(1.4);
  }
}
.round {
  margin-top: 0.6cqw;
  font-size: 0.7cqw;
  padding: 0.4cqw 1.2cqw;
  background: var(--ink);
  border: 0.2cqw solid #4a5bd8;
}
.combo {
  position: absolute;
  top: 12cqw;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.p1 .combo {
  left: 0.5cqw;
}
.p2 .combo {
  right: 0.5cqw;
  text-align: right;
}
.combo.show {
  opacity: 1;
}
.combo.bump .combo-hits {
  animation: bump 0.18s ease-out;
}
.combo-hits {
  /* digit height */
  font-size: 3.2cqw;
  display: flex;
  align-items: flex-end;
  gap: 0.4cqw;
  color: var(--p1);
  text-shadow:
    0.2cqw 0.2cqw 0 var(--ink),
    -0.1cqw -0.1cqw 0 var(--ink);
}
.combo-word {
  font-size: 0.42em;
  margin-bottom: 0.18em;
}
.p2 .combo-hits,
.p2 .combo-damage {
  justify-content: flex-end;
}
.p2 .combo-hits {
  color: var(--p2);
}
.combo-damage {
  margin-top: 0.4cqw;
  font-size: 1.8cqw;
  display: flex;
  align-items: flex-end;
  gap: 0.4cqw;
  text-shadow: 0.15cqw 0.15cqw 0 var(--ink);
}
.combo-name {
  margin-top: 0.4cqw;
  font-size: 0.85cqw;
  color: var(--cyan);
  text-shadow: 0.15cqw 0.15cqw 0 var(--ink);
}
.callout {
  position: absolute;
  top: 19cqw;
  font-size: 1.1cqw;
  color: #fff;
  text-shadow: 0.2cqw 0.2cqw 0 var(--ink);
  opacity: 0;
}
.p1 .callout {
  left: 0.5cqw;
}
.p2 .callout {
  right: 0.5cqw;
}
.callout.show {
  animation: callout 1.2s ease-out forwards;
}
.announce {
  position: absolute;
  top: 38%;
  left: 0;
  right: 0;
  text-align: center;
}
.announce-main {
  font-size: 7cqw;
  color: var(--p1);
  text-shadow:
    0.35cqw 0.35cqw 0 var(--p2),
    0.7cqw 0.7cqw 0 var(--ink);
  transform: rotate(-4deg);
  opacity: 0;
}
.announce-main.p2 {
  color: var(--p2);
  text-shadow:
    0.35cqw 0.35cqw 0 var(--p1),
    0.7cqw 0.7cqw 0 var(--ink);
}
.announce-main.show {
  animation: announce 0.4s cubic-bezier(0.2, 1.6, 0.4, 1) forwards;
}
.announce-sub {
  margin-top: 1cqw;
  font-size: 1.4cqw;
  text-shadow: 0.2cqw 0.2cqw 0 var(--ink);
}
@keyframes announce {
  from {
    opacity: 0;
    transform: rotate(-4deg) scale(0.3);
  }
  to {
    opacity: 1;
    transform: rotate(-4deg) scale(1);
  }
}
@keyframes bump {
  from {
    transform: scale(1.35);
  }
}
@keyframes callout {
  0% {
    opacity: 0;
    transform: translateY(1cqw);
  }
  15% {
    opacity: 1;
    transform: translateY(0);
  }
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes glow {
  to {
    filter: brightness(1.3);
  }
}
@keyframes blink {
  50% {
    color: var(--danger);
  }
}
@media (prefers-reduced-motion: reduce) {
  .announce-main.show,
  .callout.show,
  .combo.bump .combo-hits {
    animation-duration: 0.01s;
  }
}
</style>
