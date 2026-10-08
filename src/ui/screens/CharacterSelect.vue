<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { fighterAssetUrl } from '@/game/assets/atlas'
import { audioManager } from '@/game/audio/audio-manager'
import { PLAYER_SLOTS, otherSlot, type PlayerSlot } from '@/game/core/types'
import { ROSTER, rosterIndexOf } from '@/game/fighters/roster'
import type { FighterDefinition, FighterProfileText } from '@/game/fighters/types'
import { hasMenu } from '@/game/input/actions'
import { inputManager } from '@/game/input/input-manager'
import { gamepadCodeLabel, keyCodeLabel, type DeviceRef } from '@/game/input/bindings'
import FighterPreview from '../components/FighterPreview.vue'
import ShapePlate from '../components/ShapePlate.vue'
import { app, go, openOptions, saveControls } from '../store'
import { useMenuInput } from '../use-menu-input'

interface SeatState {
  cursor: number
  ready: boolean
}

const vsAi = app.mode === 'ai'
const seats = reactive<[SeatState, SeatState]>([
  { cursor: Math.max(0, rosterIndexOf(app.selection[0])), ready: false },
  { cursor: Math.max(0, rosterIndexOf(app.selection[1])), ready: false },
])
/** vs AI: the AI's quick "roulette" pick runs after player 1 confirms */
let rouletteTimer = 0
onBeforeUnmount(() => window.clearTimeout(rouletteTimer))
const deviceTick = ref(0)
/**
 * Versus: seats are taken in press order every time this screen opens —
 * the first device to press anything becomes player 1, the next one player 2.
 */
const claimed = reactive<[boolean, boolean]>([vsAi, vsAi])
const unsubscribe = inputManager.onDevicesChanged(() => deviceTick.value++)
onBeforeUnmount(unsubscribe)
let startTimer = 0
onBeforeUnmount(() => window.clearTimeout(startTimer))

/** bumps per seat to replay the "locked" shake */
const denied = reactive<[number, number]>([0, 0])

/** Grid rows alternate 5 and 4 slots, like the mock-up. */
const ROWS: number[][] = (() => {
  const rows: number[][] = []
  let start = 0
  let size = 5
  while (start < ROSTER.length) {
    rows.push(Array.from({ length: Math.min(size, ROSTER.length - start) }, (_, k) => start + k))
    start += size
    size = size === 5 ? 4 : 5
  }
  return rows
})()

function lockedName(slot: PlayerSlot): string {
  const e = ROSTER[seats[slot].cursor]
  return e?.kind === 'locked' ? (e.name ?? '???') : ''
}

function lockedProfile(slot: PlayerSlot): FighterProfileText | null {
  const e = ROSTER[seats[slot].cursor]
  return e?.kind === 'locked' ? e.profile : null
}

function lockedPortrait(slot: PlayerSlot): string {
  const e = ROSTER[seats[slot].cursor]
  return e?.kind === 'locked' ? e.portrait : ''
}

function fighterAt(slot: PlayerSlot): FighterDefinition | null {
  const e = ROSTER[seats[slot].cursor]
  return e?.kind === 'fighter' ? e.fighter : null
}

function connected(slot: PlayerSlot): boolean {
  void deviceTick.value
  if (vsAi) return true
  return claimed[slot] && inputManager.isSeatConnected(slot)
}

function deviceLabel(slot: PlayerSlot): string {
  void deviceTick.value
  if (vsAi && slot === 1) return 'AI'
  if (vsAi) return 'Клавиатура + геймпад'
  const d: DeviceRef = inputManager.controls.players[slot].device
  if (d.kind === 'keyboard') return slot === 0 ? 'Клавиатура (WASD)' : 'Клавиатура (стрелки)'
  if (d.kind === 'gamepad') return `Геймпад ${d.index + 1}`
  return 'Нет устройства'
}

const bothReady = computed(() => seats[0].ready && seats[1].ready)

function move(slot: PlayerSlot, dx: number, dy: number): void {
  const s = seats[slot]
  if (s.ready) return
  const n = ROSTER.length
  let i = s.cursor
  if (dx !== 0) i = (((i + dx) % n) + n) % n
  if (dy !== 0) {
    const r = ROWS.findIndex((row) => row.includes(i))
    const row = ROWS[r]
    const target = ROWS[(r + dy + ROWS.length) % ROWS.length]
    if (row && target) {
      const col = row.indexOf(i)
      i = target[Math.min(col, target.length - 1)] ?? i
    }
  }
  if (i !== s.cursor) {
    s.cursor = i
    audioManager.play('ui-move')
  }
}

function confirm(slot: PlayerSlot): void {
  const s = seats[slot]
  if (bothReady.value) {
    startFight()
    return
  }
  if (s.ready) return
  if (!fighterAt(slot)) {
    // locked slot: cannot be picked yet
    denied[slot]++
    audioManager.play('ui-back')
    return
  }
  s.ready = true
  audioManager.play('ui-confirm')
  if (vsAi && slot === 0) {
    aiChoose()
    return
  }
  if (bothReady.value) {
    window.clearTimeout(startTimer)
    startTimer = window.setTimeout(startFight, LOCK_IN_MS)
  }
}

/**
 * The AI picks its own fighter: the cursor spins through the roster, slows
 * down and stops on a random fighter, then the match starts.
 */
/** the AI's roulette is spinning: its side shows only faces, no description */
const rolling = ref(false)

/** face shown during the roulette for the seat's current slot */
function rollFace(slot: PlayerSlot): { src: string; locked: boolean } {
  const e = ROSTER[seats[slot].cursor]
  if (!e) return { src: '', locked: true }
  return e.kind === 'fighter' ? { src: portrait(e.fighter), locked: false } : { src: e.portrait, locked: true }
}

function aiChoose(): void {
  window.clearTimeout(rouletteTimer)
  rolling.value = true
  const n = ROSTER.length
  // the AI only lands on playable fighters, the spin passes over all slots
  const playable = ROSTER.flatMap((e, i) => (e.kind === 'fighter' ? [i] : []))
  const target = playable[Math.floor(Math.random() * playable.length)] ?? 0
  const ai = seats[1]
  ai.ready = false
  const steps = n > 1 ? 10 : 0
  const spin = (left: number): void => {
    if (left <= 0) {
      ai.cursor = target
      rolling.value = false // the full fighter + description appear only now
      ai.ready = true
      audioManager.play('ui-confirm')
      window.clearTimeout(startTimer)
      startTimer = window.setTimeout(startFight, LOCK_IN_MS)
      return
    }
    ai.cursor = (ai.cursor + 1) % n
    audioManager.play('ui-move')
    // decelerate towards the end of the spin
    rouletteTimer = window.setTimeout(() => spin(left - 1), 55 + (steps - left) * 18)
  }
  spin(steps)
}

function back(slot: PlayerSlot): void {
  window.clearTimeout(startTimer)
  if (vsAi) {
    // one human: "back" undoes both picks, or leaves the screen
    if (seats[0].ready) {
      window.clearTimeout(rouletteTimer)
      rolling.value = false
      seats[0].ready = false
      seats[1].ready = false
      audioManager.play('ui-back')
      return
    }
    audioManager.play('ui-back')
    go('menu')
    return
  }
  const s = seats[slot]
  if (s.ready) {
    s.ready = false
    audioManager.play('ui-back')
    return
  }
  audioManager.play('ui-back')
  go('menu')
}

function startFight(): void {
  window.clearTimeout(startTimer)
  if (!bothReady.value || app.screen !== 'select') return
  app.selection = [fighterAt(0)?.id ?? '', fighterAt(1)?.id ?? '']
  go('location')
}

function handleSeat(slot: PlayerSlot, mask: number): void {
  if (hasMenu(mask, 'left')) move(slot, -1, 0)
  if (hasMenu(mask, 'right')) move(slot, 1, 0)
  if (hasMenu(mask, 'up')) move(slot, 0, -1)
  if (hasMenu(mask, 'down')) move(slot, 0, 1)
  if (hasMenu(mask, 'confirm')) confirm(slot)
  if (hasMenu(mask, 'back')) back(slot)
}

function assign(slot: PlayerSlot, device: DeviceRef): void {
  inputManager.controls.players[slot].device = device
  saveControls()
  deviceTick.value++
}

/** Short key hint for a seat, e.g. "A W D · J K L U I". */
function keysHint(slot: PlayerSlot): string {
  void deviceTick.value
  const pc = inputManager.controls.players[slot]
  if (vsAi) return ''
  if (pc.device.kind === 'keyboard') {
    const k = (codes: readonly string[]): string => (codes[0] ? keyCodeLabel(codes[0]) : '—')
    const kb = pc.keyboard
    return `${k(kb.left)} ${k(kb.jump)} ${k(kb.right)} · ${k(kb.light)} ${k(kb.heavy)} ${k(kb.kick)} ${k(kb.special)} ${k(kb.block)}`
  }
  if (pc.device.kind === 'gamepad') {
    const g = (codes: readonly number[]): string => (codes[0] !== undefined ? gamepadCodeLabel(codes[0]) : '—')
    const gp = pc.gamepad
    return `${g(gp.light)} ${g(gp.heavy)} ${g(gp.kick)} ${g(gp.special)} · блок ${g(gp.block)}`
  }
  return ''
}

/** Exchange the two seats' devices (e.g. keyboard ↔ gamepad). */
function swapDevices(): void {
  if (vsAi || seats[0].ready || seats[1].ready) return
  const [p1, p2] = inputManager.controls.players
  const d = p1.device
  p1.device = p2.device
  p2.device = d
  // keyboard binding sets and "seat taken" travel with their device
  const kb = p1.keyboard
  p1.keyboard = p2.keyboard
  p2.keyboard = kb
  const c = claimed[0]
  claimed[0] = claimed[1]
  claimed[1] = c
  saveControls()
  deviceTick.value++
  audioManager.play('ui-move')
}

function padRef(index: number): DeviceRef {
  const info = inputManager.listGamepads().find((g) => g.index === index)
  return { kind: 'gamepad', index, id: info?.id ?? null }
}

function ownsPad(slot: PlayerSlot, index: number): boolean {
  const d = inputManager.controls.players[slot].device
  return claimed[slot] && d.kind === 'gamepad' && inputManager.resolvePad(d) === index
}

/** Keyboard binding sets belong to seats; give `slot` the set that was just pressed. */
function swapKeyboardSets(): void {
  const [p1, p2] = inputManager.controls.players
  const kb = p1.keyboard
  p1.keyboard = p2.keyboard
  p2.keyboard = kb
}

function claim(slot: PlayerSlot, device: DeviceRef): void {
  inputManager.controls.players[slot].device = device
  claimed[slot] = true
  saveControls()
  deviceTick.value++
  audioManager.play('ui-confirm')
}

/**
 * Gives the first free seat to a device that pressed something and owns no
 * seat yet. One claim per frame. Returns true if a seat was taken.
 */
function claimSeat(): boolean {
  const free = PLAYER_SLOTS.find((s) => !claimed[s])
  if (free === undefined) return false
  const other = otherSlot(free)
  const otherKb = claimed[other] && inputManager.controls.players[other].device.kind === 'keyboard'

  // gamepads: a pad pressed in the same frame as an owned pad is a duplicate
  // of that controller (Steam / DS4Windows), not a second player
  const pressed = inputManager.padsPressed()
  if (!pressed.some((i) => ownsPad(other, i))) {
    const pad = pressed.find((i) => !ownsPad(other, i))
    if (pad !== undefined) {
      claim(free, padRef(pad))
      return true
    }
  }

  // keyboard: each binding set (WASD… / arrows…) acts as its own device
  if (inputManager.keyboardPressedFor(free)) {
    claim(free, { kind: 'keyboard' })
    return true
  }
  if (inputManager.keyboardPressedFor(other) && !otherKb) {
    swapKeyboardSets() // the keys that were pressed now belong to this seat
    claim(free, { kind: 'keyboard' })
    return true
  }
  if (inputManager.keyboardConfirmPressed() && !otherKb) {
    claim(free, { kind: 'keyboard' })
    return true
  }
  return false
}

useMenuInput(({ any, players }) => {
  if (vsAi) {
    // single human: keyboard and every gamepad control player 1 together
    handleSeat(0, any)
    return
  }
  if (claimSeat()) return
  if (!claimed[0] && !claimed[1] && hasMenu(any, 'back')) {
    audioManager.play('ui-back')
    go('menu')
    return
  }
  for (const slot of PLAYER_SLOTS) if (claimed[slot]) handleSeat(slot, players[slot])
})

/** player colour (yellow / pink, as in the mock-up) */
function accent(slot: PlayerSlot): string {
  return slot === 0 ? '#ffc21a' : '#ff2ea8'
}

interface StatRow {
  label: string
  value: string
  icon: 'gear' | 'shoe' | 'heart'
}

function stats(slot: PlayerSlot): StatRow[] {
  const prof = fighterAt(slot)?.profile ?? lockedProfile(slot)
  return [
    { label: 'Архетип', value: prof?.archetype ?? '???', icon: 'gear' },
    { label: 'Скорость', value: prof?.speed ?? '???', icon: 'shoe' },
    { label: 'Жизни', value: prof?.health ?? '???', icon: 'heart' },
  ]
}

/** how long the final "your choice — VS" layout stays before the fight */
const LOCK_IN_MS = 2000

/** "pick" button art (btn.png); tinted pink on player 2's side */
const BUTTON_ART = `${import.meta.env.BASE_URL}assets/ui/btn.webp`

/** big lightning panels behind each player's fighter (select.png) */
const PANEL_P1 = `${import.meta.env.BASE_URL}assets/ui/select-panel-p1.webp`
const PANEL_P2 = `${import.meta.env.BASE_URL}assets/ui/select-panel-p2.webp`
/** name plates (title-borders.png) */
const NAME_P1 = `${import.meta.env.BASE_URL}assets/ui/name-plate-p1.webp`
const NAME_P2 = `${import.meta.env.BASE_URL}assets/ui/name-plate-p2.webp`
/** the same panels with the middle cut out (only the lightning ring) */
const PANEL_P1_FRAME = `${import.meta.env.BASE_URL}assets/ui/select-panel-p1-frame.webp`
const PANEL_P2_FRAME = `${import.meta.env.BASE_URL}assets/ui/select-panel-p2-frame.webp`

/** roster slot frames (borders.png): idle silver / selected gold */
const FRAME_IDLE = `${import.meta.env.BASE_URL}assets/ui/slot-frame.webp`
const FRAME_ACTIVE = `${import.meta.env.BASE_URL}assets/ui/slot-frame-active.webp`

/** the fighter's face only, centred for the slot window (tools/make_faces.py) */
function portrait(def: FighterDefinition): string {
  return fighterAssetUrl(def.assetDir, `face-${def.portraits.select}.webp`)
}

function clickFighter(slot: PlayerSlot, i: number): void {
  if (vsAi && slot === 1) return // the AI picks for itself
  if (seats[slot].ready) return
  seats[slot].cursor = i
  audioManager.play('ui-move')
}
</script>

<template>
  <div class="screen select" :class="{ chosen: bothReady }">
    <div
      v-for="slot in PLAYER_SLOTS"
      :key="slot"
      class="half"
      :class="[slot === 0 ? 'left' : 'right', { ready: seats[slot].ready, waiting: vsAi && slot === 1 && !seats[0].ready }]"
    >
      <!-- one-shot flash when the seat locks in its pick -->
      <div v-if="seats[slot].ready" class="ready-flash" />

      <div :key="`${slot}-${denied[slot]}`" class="stage-panel" :class="{ shake: denied[slot] > 0 }">
        <img class="panel-art" :src="slot === 0 ? PANEL_P1 : PANEL_P2" alt="" draggable="false" />

        <!-- AI roulette: only the face of the slot under the cursor, centred -->
        <div v-if="rolling && slot === 1" :key="`roll-${seats[slot].cursor}`" class="roll-face">
          <img :src="rollFace(slot).src" :class="{ silhouette: rollFace(slot).locked }" alt="" draggable="false" />
        </div>
        <template v-else-if="connected(slot)">
          <FighterPreview
            v-if="fighterAt(slot)"
            :key="`sprite-${seats[slot].cursor}`"
            class="hero-sprite"
            :fighter-id="fighterAt(slot)?.id ?? ''"
            :pose="seats[slot].ready ? 'win' : 'idle'"
            :flip="slot === 1"
          />
          <div v-else :key="`locked-${seats[slot].cursor}`" class="hero-sprite hero-locked">
            <img :src="lockedPortrait(slot)" class="silhouette" alt="" draggable="false" />
            <span class="question">?</span>
          </div>

          <!-- the name sits on top of the lightning ring; only the stats tuck under it -->
          <div :key="`name-${seats[slot].cursor}`" class="name-wrap">
            <img class="name-art" :src="slot === 0 ? NAME_P1 : NAME_P2" alt="" draggable="false" />
            <span class="name">{{ fighterAt(slot)?.name ?? lockedName(slot) }}</span>
          </div>
          <!-- final layout: big "your choice" banner above the name -->
          <div v-if="bothReady" class="choice-wrap">
            <img class="name-art" :src="slot === 0 ? NAME_P1 : NAME_P2" alt="" draggable="false" />
            <span class="choice-text">Ваш выбор</span>
          </div>
          <div :key="`card-${seats[slot].cursor}`" class="info">
            <ShapePlate v-for="row in stats(slot)" :key="row.label" shape="stat" class="stat-row" fill="#141033" :stroke="accent(slot)">
              <span class="stat-icon" :class="row.icon" aria-hidden="true">
                <svg v-if="row.icon === 'gear'" viewBox="0 0 24 24">
                  <path
                    d="M10.3 2h3.4l.5 2.6 1.6.7 2.2-1.5 2.4 2.4-1.5 2.2.7 1.6 2.6.5v3.4l-2.6.5-.7 1.6 1.5 2.2-2.4 2.4-2.2-1.5-1.6.7-.5 2.6h-3.4l-.5-2.6-1.6-.7-2.2 1.5-2.4-2.4 1.5-2.2-.7-1.6L2 13.7v-3.4l2.6-.5.7-1.6-1.5-2.2 2.4-2.4 2.2 1.5 1.6-.7zM12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"
                  />
                </svg>
                <svg v-else-if="row.icon === 'shoe'" viewBox="0 0 24 24">
                  <path d="M2 15.5c0-1 .6-1.8 1.5-2.2L7 12l2-4h3l1 3 4 1.5c2.5 1 5 2.3 5 4.5v1H3c-.6 0-1-.4-1-1z" />
                  <path d="M2 19h20v1.5H2z" />
                </svg>
                <svg v-else viewBox="0 0 24 24">
                  <path d="M12 21s-8-5.2-8-11a4.6 4.6 0 018-3 4.6 4.6 0 018 3c0 5.8-8 11-8 11z" />
                </svg>
              </span>
              <span class="stat-text">
                <b :style="{ color: accent(slot) }">{{ row.label }}</b>
                <span>{{ row.value }}</span>
              </span>
            </ShapePlate>
            <div v-if="!fighterAt(slot)" class="soon">🔒 Скоро</div>
          </div>

          <div v-if="seats[slot].ready && !bothReady" class="ready-stamp" :class="slot === 0 ? 'p1' : 'p2'">Готов!</div>
        </template>

        <div v-else class="join">
          <div class="join-title" :style="{ color: accent(slot) }">Игрок {{ slot + 1 }}</div>
          <p>Нажмите любую кнопку<br />на геймпаде или клавиатуре</p>
          <p class="join-hint">WASD + J K L &nbsp;·&nbsp; стрелки + Num1–5</p>
          <button class="btn ghost" @click="openOptions('controls')">Управление</button>
        </div>
        <!-- the lightning ring drawn again on top: the info plates tuck under it -->
        <img class="panel-frame" :src="slot === 0 ? PANEL_P1_FRAME : PANEL_P2_FRAME" alt="" draggable="false" />
      </div>

      <ShapePlate shape="tag" class="player-tag" fill="#141033" :stroke="accent(slot)" :flip="slot === 1">
        <span class="tag-text" :style="{ color: accent(slot) }">{{ vsAi && slot === 1 ? 'AI' : `PLAYER ${slot + 1}` }}</span>
      </ShapePlate>

      <template v-if="connected(slot)">
        <div class="roster">
          <button
            v-for="(e, i) in ROSTER"
            :key="e.id"
            class="slot-btn"
            :class="{ active: seats[slot].cursor === i, locked: e.kind === 'locked' }"
            @click="clickFighter(slot, i)"
          >
            <span class="slot-face">
              <img v-if="e.kind === 'fighter'" :src="portrait(e.fighter)" :alt="e.fighter.name" draggable="false" />
              <template v-else>
                <img :src="e.portrait" class="silhouette" alt="Закрыто" draggable="false" />
                <span class="slot-lock">🔒</span>
              </template>
            </span>
            <img class="slot-frame" :src="seats[slot].cursor === i ? FRAME_ACTIVE : FRAME_IDLE" alt="" draggable="false" />
          </button>
        </div>

        <div class="actions">
          <button
            class="pick-btn"
            :class="slot === 0 ? 'p1' : 'p2'"
            :disabled="(vsAi && slot === 1) || (!seats[slot].ready && !fighterAt(slot))"
            @click="seats[slot].ready ? back(slot) : confirm(slot)"
          >
            <img class="pick-art" :src="BUTTON_ART" alt="" draggable="false" />
            <span class="pick-text">{{ seats[slot].ready ? 'Готов ✓' : fighterAt(slot) ? 'Выбрать' : 'Закрыто' }}</span>
          </button>
        </div>

        <div v-if="!vsAi" class="device-hint">{{ deviceLabel(slot) }} · {{ keysHint(slot) }}</div>
      </template>
    </div>

    <div class="divider" aria-hidden="true">
      <svg class="divider-burst" viewBox="0 0 100 100">
        <polygon
          points="50,0 56,38 78,10 62,42 100,50 62,58 78,90 56,62 50,100 44,62 22,90 38,58 0,50 38,42 22,10 44,38"
          fill="#fff"
        />
      </svg>
    </div>
    <button
      v-if="!vsAi"
      class="swap"
      title="Поменять устройства игроков местами"
      :disabled="seats[0].ready || seats[1].ready"
      @click="swapDevices"
    >
      ⇄
    </button>
    <div v-if="bothReady" class="vs-badge" aria-label="VS">
      <svg class="vs-burst" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true">
        <polygon
          points="50,0 57,20 74,4 68,24 96,14 78,32 100,40 76,44 90,64 66,52 58,70 50,54 42,70 34,52 10,64 24,44 0,40 22,32 4,14 32,24 26,4 43,20"
        />
      </svg>
      <span class="vs-text">VS</span>
    </div>
    <button class="back" @click="go('menu')">← Назад</button>
  </div>
</template>

<style scoped>
/*
 * Layout follows the character-select mock-up. Each half is 50cqw wide and
 * 56.25cqw tall; everything is placed absolutely in cqw so it scales with
 * the stage.
 */
.select {
  flex-direction: row;
}
.half {
  position: relative;
  width: 50%;
  height: 100%;
}
/* scene shows through at the top, the player colour floods the floor */
.half.left {
  background: linear-gradient(
    180deg,
    rgba(255, 196, 26, 0.06) 0%,
    rgba(255, 196, 26, 0.12) 45%,
    rgba(255, 194, 26, 0.35) 66%,
    rgba(255, 190, 24, 0.5) 82%,
    rgba(255, 177, 15, 0.6) 100%
  );
}
.half.right {
  background: linear-gradient(
    180deg,
    rgba(255, 46, 168, 0.06) 0%,
    rgba(255, 46, 168, 0.12) 45%,
    rgba(255, 58, 180, 0.35) 66%,
    rgba(255, 58, 180, 0.5) 82%,
    rgba(240, 28, 156, 0.6) 100%
  );
}
.half.waiting {
  filter: saturate(0.5) brightness(0.75);
}

/* ------------------------------------------------------------- panel */
.stage-panel {
  position: absolute;
  left: 1.5cqw;
  top: 3.2cqw;
  width: 47cqw;
  height: 30.7cqw; /* aspect of the panel art (select.png) */
}
.stage-panel.shake {
  animation: shake 0.3s ease;
}
.panel-art,
.panel-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* layers: panel → info plates → lightning ring → fighter */
.panel-frame {
  z-index: 2;
}
.hero-sprite {
  z-index: 3;
}
.info {
  z-index: 1;
}
.name-wrap {
  z-index: 3;
}
.join {
  z-index: 3;
}
.hero-sprite {
  position: absolute;
  top: -2.2cqw;
  width: 21cqw;
  height: 33cqw;
}
.left .hero-sprite {
  left: 2.5cqw;
}
.right .hero-sprite {
  right: 2.5cqw;
}
.roll-face {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 3;
  width: 15cqw;
  height: 15cqw;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  animation: roll-pop 0.16s ease-out;
}
.roll-face img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 0 1.2cqw rgba(255, 255, 255, 0.55));
}
.roll-face img.silhouette {
  filter: brightness(0) drop-shadow(0 0 0.3cqw rgba(160, 140, 255, 0.9));
}
@keyframes roll-pop {
  from {
    transform: translate(-50%, -50%) scale(0.85);
    opacity: 0.6;
  }
}
.hero-locked {
  display: grid;
  place-items: center;
}
.hero-locked .silhouette {
  width: 70%;
  max-height: 60%;
  object-fit: contain;
}
.question {
  position: absolute;
  font-size: 8cqw;
  color: #fff;
  text-shadow:
    0.3cqw 0.3cqw 0 var(--ink),
    0 0 2cqw rgba(160, 140, 255, 0.9);
}

/* ---------------------------------------------------------- info card */
.name-wrap {
  /* name plate art (title-borders.png): its dark window sits where the old
     plate was, its lightning tails hang over the stat rows */
  position: absolute;
  top: 7.6cqw;
  width: 21cqw;
  animation: card-in 0.3s cubic-bezier(0.2, 1.2, 0.4, 1) 0.04s both;
}
.left .name-wrap {
  left: 22.5cqw;
  --from: 18%;
}
.right .name-wrap {
  left: 3.5cqw;
  --from: -18%;
}
.name-art {
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;
}
.info {
  /* the stat rows reach into the lightning ring and tuck under it */
  position: absolute;
  top: 12.75cqw; /* below the name plate */
  width: 20cqw;
  display: flex;
  flex-direction: column;
  gap: 0.55cqw;
}
.left .name {
  left: 52.9%;
  top: 27.4%;
}
.right .name {
  left: 47.4%;
  top: 27.9%;
}
.left .info {
  left: 24.5cqw;
  align-items: flex-start;
}
.right .info {
  left: 1cqw;
  align-items: flex-end;
}
.name {
  /* centre of the plate's dark window */
  position: absolute;
  transform: translate(-50%, -50%);
  white-space: nowrap;
  font-size: 1.2cqw;
  color: #fff;
  text-transform: uppercase;
  text-shadow: 0.18cqw 0.18cqw 0 #0b0614;
}
.stat-row {
  width: 92%;
  height: 3.1cqw;
}
.stat-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 2.2cqw;
  height: 2.2cqw;
  margin-left: 1.3cqw;
  margin-right: 0.7cqw;
}
.stat-icon svg {
  width: 100%;
  height: 100%;
  fill: currentColor;
}
.left .stat-icon {
  color: var(--p1);
}
.right .stat-icon {
  color: var(--p2);
}
.stat-text {
  display: flex;
  flex-direction: column;
  gap: 0.25cqw;
  min-width: 0;
}
.stat-text b {
  font-size: 0.78cqw;
  font-weight: normal;
}
.stat-text span {
  font-size: 0.56cqw;
  color: #fff;
  text-transform: uppercase;
  white-space: nowrap;
}
.soon {
  font-size: 0.85cqw;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 0.15cqw 0.15cqw 0 #0b0614;
}

/* --------------------------------------------------------- player tag */
.player-tag {
  position: absolute;
  top: 1cqw;
  left: 50%;
  transform: translateX(-50%);
  width: 21cqw;
  height: 3.8cqw;
  z-index: 2;
}
.player-tag :deep(.plate-content) {
  justify-content: center;
}
.tag-text {
  font-size: 1.8cqw;
  text-shadow: 0.15cqw 0.15cqw 0 #0b0614;
}

/* ------------------------------------------------------------- roster */
.roster {
  position: absolute;
  top: 36.2cqw;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.8cqw;
  width: calc(5 * 6cqw + 4 * 0.8cqw);
}
/*
 * Slot = the frame's body (aspect of the art in borders.png: blue idle / yellow selected). The portrait
 * sits in the frame's window; the frame image is drawn on top and is larger
 * than the slot so the selected frame's glow can spill outside.
 */
.slot-btn {
  position: relative;
  width: 6cqw;
  height: 5.51cqw;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  overflow: visible;
}
.slot-face {
  position: absolute;
  /* thinner frames (tools/thin_frames.py) leave a bigger window; the window
     tucks slightly under the band so no hairline gap can show */
  left: 6.5%;
  right: 6.5%;
  top: 5.5%;
  bottom: 5.5%;
  overflow: hidden;
  /* lit niche behind the head, in the frame's colour */
  background: radial-gradient(ellipse at 50% 45%, #183a82 0%, #0b0a22 72%);
}
.slot-btn.active .slot-face {
  background: radial-gradient(ellipse at 50% 45%, #7a5414 0%, #0b0a22 72%);
}
.right .slot-btn.active .slot-face {
  background: radial-gradient(ellipse at 50% 45%, #7a1450 0%, #0b0a22 72%);
}
.slot-btn.locked .slot-face {
  background: radial-gradient(ellipse at 50% 45%, #2a2350 0%, #0b0a22 72%);
}
.slot-frame {
  position: absolute;
  left: -5.66%;
  top: -10.41%;
  width: 111.57%;
  height: 121.51%;
  pointer-events: none;
}
.silhouette {
  /* locked fighters: dark silhouette with a faint rim */
  filter: brightness(0) drop-shadow(0 0 0.12cqw rgba(160, 140, 255, 0.9));
  opacity: 0.9;
}
.slot-lock {
  /* lock dead centre of the slot window */
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 1.5cqw;
  line-height: 1;
}
.hero-locked {
  position: relative;
  display: grid;
  place-items: center;
}
.hero-locked .silhouette {
  width: 80%;
  max-height: 80%;
  object-fit: contain;
}
.question {
  position: absolute;
  font-size: 8cqw;
  color: #fff;
  text-shadow:
    0.3cqw 0.3cqw 0 var(--ink),
    0 0 2cqw rgba(160, 140, 255, 0.9);
}
.soon {
  margin-top: 0.8cqw;
  font-size: 0.9cqw;
  text-transform: uppercase;
  color: #e6dcff;
}
.label {
  display: flex;
  align-items: center;
  gap: 0.5cqw;
}
.ico {
  font-style: normal;
  font-size: 1cqw;
  width: 1.4cqw;
  text-align: center;
}
.hero.shake {
  animation: shake 0.3s ease;
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
.slot-face img {
  display: block;
  width: 100%;
  height: 100%;
  /* faces are cut to the window's aspect, centred on the face (tools/make_faces.py) */
  object-fit: cover;
  object-position: center center;
}
.slot-face img.silhouette {
  object-fit: contain;
  padding: 0.3cqw;
  box-sizing: border-box;
}
.slot-btn.active {
  z-index: 1; /* glow over the neighbours */
  transform: scale(1.06);
}
/* player 2's side is pink in the mock-up: tint the gold frame */
.right .slot-btn.active .slot-frame {
  filter: hue-rotate(-75deg) saturate(1.3);
}

/* ------------------------------------------------------------- button */
.actions {
  position: absolute;
  top: 47.7cqw;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.9cqw;
}
.pick-btn {
  position: relative;
  width: 22cqw;
  height: 6.08cqw; /* aspect of btn.png */
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  font-family: var(--font);
}
.pick-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.pick-btn.p2 .pick-art {
  filter: hue-rotate(-75deg) saturate(1.3);
}
.pick-text {
  /* centre of the plate's face in the art */
  position: absolute;
  left: 51%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 1.6cqw;
  text-transform: uppercase;
  white-space: nowrap;
}
.pick-btn.p1 .pick-text {
  color: #141033;
  text-shadow: 0.12cqw 0.12cqw 0 #fff3a0;
}
.pick-btn.p2 .pick-text {
  color: #fff;
  text-shadow: 0.15cqw 0.15cqw 0 #6b0040;
}
.pick-btn:hover:not(:disabled),
.pick-btn:focus-visible {
  filter: brightness(1.12);
}
.pick-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.pick-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.half.ready .pick-btn {
  filter: brightness(1.15);
}
.device-hint {
  position: absolute;
  bottom: 0.35cqw;
  width: 100%;
  text-align: center;
  font-size: 0.55cqw;
  color: rgba(255, 255, 255, 0.8);
  text-shadow: 0.1cqw 0.1cqw 0 #0b0614;
}

/* ------------------------------------------------------- join (no device) */
.join {
  position: absolute;
  inset: 22% 18%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8cqw;
  text-align: center;
  font-size: 0.95cqw;
  line-height: 1.8;
  color: #fff;
  text-shadow: 0.15cqw 0.15cqw 0 #0b0614;
}
.join p {
  margin: 0;
}
.join-title {
  font-size: 1.8cqw;
}
.join-hint {
  font-size: 0.65cqw;
}

/* ------------------------------------------------------------ divider */
.divider {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 0.55cqw;
  transform: translateX(-50%);
  background: linear-gradient(90deg, var(--p1), #fff 35%, #fff 65%, var(--p2));
  box-shadow: 0 0 1.4cqw #fff;
  pointer-events: none;
}
.divider-burst {
  position: absolute;
  left: 50%;
  top: 24.5cqw;
  width: 9cqw;
  height: 13cqw;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 0 0.6cqw #fff) drop-shadow(0 0 1.4cqw var(--p2));
}

/* -------------------------------------------------------------- misc */
.swap {
  position: absolute;
  left: 50%;
  bottom: 2.2cqw;
  transform: translateX(-50%);
  width: 3.2cqw;
  height: 3.2cqw;
  font-family: var(--font);
  font-size: 1.4cqw;
  color: var(--ink);
  background: #fff;
  border: 0.3cqw solid var(--ink);
  cursor: pointer;
  z-index: 3;
}
.swap:hover {
  background: var(--p1);
}
.swap:disabled {
  opacity: 0.4;
  cursor: default;
}
.back {
  position: absolute;
  left: 0.8cqw;
  top: 0.8cqw;
  z-index: 3;
  font-family: var(--font);
  font-size: 0.6cqw;
  color: #fff;
  background: rgba(20, 16, 51, 0.75);
  border: 0.15cqw solid rgba(255, 255, 255, 0.5);
  padding: 0.5cqw 0.8cqw;
  cursor: pointer;
}
.fight-banner {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-6deg);
  font-size: 7cqw;
  animation: pop 0.35s cubic-bezier(0.2, 1.6, 0.4, 1);
  pointer-events: none;
  z-index: 4;
}
@keyframes pop {
  from {
    transform: translate(-50%, -50%) rotate(-6deg) scale(0.3);
    opacity: 0;
  }
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
/* ---------------------------------------------------------- selection fx */

/* cursor lands on a slot: the whole slot pops, the frame flashes */
.slot-btn.active {
  animation: slot-pop 0.32s cubic-bezier(0.2, 1.8, 0.4, 1);
}
.slot-btn.active .slot-frame {
  animation: frame-flash 0.32s ease-out;
}
/* ...and a light streak sweeps across the portrait */
.slot-btn.active .slot-face::after {
  content: '';
  position: absolute;
  inset: -20% auto -20% -60%;
  width: 45%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  transform: skewX(-18deg);
  animation: shine 0.45s ease-out forwards;
  pointer-events: none;
}
/* locked in: the chosen slot keeps pulsing (frame and picture together) */
.half.ready .slot-btn.active {
  animation: slot-pulse 0.9s ease-in-out infinite alternate;
}

/* new fighter in the big window: flies in with a flash */
.hero-sprite {
  animation: hero-in 0.34s cubic-bezier(0.2, 1.4, 0.4, 1);
}
.left .hero-sprite {
  --from: -12%;
}
.right .hero-sprite {
  --from: 12%;
}
.info {
  animation: card-in 0.3s cubic-bezier(0.2, 1.2, 0.4, 1) 0.04s both;
}
.left .info {
  --from: 18%;
}
.right .info {
  --from: -18%;
}

/* the panel flares up once the pick is confirmed */
.half.ready .panel-art {
  animation: panel-flare 0.6s ease-out, panel-glow 1.2s ease-in-out 0.6s infinite alternate;
}

.ready-flash {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: #fff;
  pointer-events: none;
  animation: ready-flash 0.45s ease-out forwards;
}
.ready-stamp {
  position: absolute;
  z-index: 4;
  left: 50%;
  top: 46%;
  font-size: 4.2cqw;
  text-transform: uppercase;
  pointer-events: none;
  text-shadow:
    0.3cqw 0.3cqw 0 var(--ink),
    -0.15cqw -0.15cqw 0 var(--ink);
  animation: stamp 0.42s cubic-bezier(0.2, 1.8, 0.4, 1) both;
}
.ready-stamp.p1 {
  color: var(--p1);
}
.ready-stamp.p2 {
  color: var(--p2);
}

@keyframes slot-pop {
  0% {
    transform: scale(0.88);
  }
  100% {
    transform: scale(1.06);
  }
}
@keyframes slot-pulse {
  from {
    transform: scale(1.06);
  }
  to {
    transform: scale(1.11);
  }
}
@keyframes frame-flash {
  0% {
    filter: brightness(2);
  }
  100% {
    filter: brightness(1);
  }
}
.right .slot-btn.active .slot-frame {
  /* keep the pink tint while flashing */
  animation-name: frame-flash-pink;
}
@keyframes frame-flash-pink {
  0% {
    filter: hue-rotate(-75deg) saturate(1.3) brightness(2);
  }
  100% {
    filter: hue-rotate(-75deg) saturate(1.3) brightness(1);
  }
}
@keyframes shine {
  to {
    left: 130%;
  }
}
@keyframes hero-in {
  0% {
    opacity: 0;
    transform: translateX(var(--from)) scale(0.88);
    filter: brightness(3);
  }
  60% {
    opacity: 1;
    filter: brightness(1.4);
  }
  100% {
    transform: none;
    filter: none;
  }
}
@keyframes card-in {
  from {
    opacity: 0;
    transform: translateX(var(--from));
  }
}
@keyframes panel-flare {
  0% {
    filter: brightness(2.2);
  }
  100% {
    filter: brightness(1);
  }
}
@keyframes panel-glow {
  to {
    filter: brightness(1.18);
  }
}
@keyframes ready-flash {
  from {
    opacity: 0.75;
  }
  to {
    opacity: 0;
  }
}
@keyframes stamp {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) rotate(-12deg) scale(3);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) rotate(-8deg) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .slot-btn.active,
  .slot-btn.active .slot-frame,
  .slot-btn.active .slot-face::after,
  .half.ready .slot-btn.active,
  .hero-sprite,
  .info,
  .name-wrap,
  .roll-face,
  .half.ready .panel-art,
  .ready-flash,
  .ready-stamp {
    animation: none;
  }
}
/* ------------------------------------------------- both picks locked in */
.roster,
.actions,
.device-hint,
.swap,
.back {
  transition: opacity 0.25s ease;
}
.select.chosen .roster,
.select.chosen .actions,
.select.chosen .device-hint,
.select.chosen .swap,
.select.chosen .back {
  opacity: 0;
  pointer-events: none;
}
/* panels and tags glide down to the middle of the screen */
.stage-panel {
  transition: transform 0.5s cubic-bezier(0.2, 1.2, 0.4, 1);
}
.select.chosen .stage-panel {
  transform: translateY(8.5cqw);
}
.player-tag {
  transition: top 0.5s cubic-bezier(0.2, 1.2, 0.4, 1);
}
.select.chosen .player-tag {
  top: 9.6cqw;
}
/* name and stats make room for the "your choice" banner */
.name-wrap,
.info {
  transition: top 0.4s ease;
}
.select.chosen .name-wrap {
  top: 9.8cqw;
}
.select.chosen .info {
  top: 14.4cqw;
}
.choice-wrap {
  position: absolute;
  z-index: 3;
  top: 3.9cqw;
  width: 24cqw;
  animation: choice-in 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) 0.15s both;
}
.left .choice-wrap {
  left: 21cqw;
}
.right .choice-wrap {
  left: 2cqw;
}
.choice-text {
  position: absolute;
  transform: translate(-50%, -50%);
  white-space: nowrap;
  font-size: 2.1cqw;
  text-transform: uppercase;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0.16cqw 0 0 #0b0614) drop-shadow(-0.16cqw 0 0 #0b0614) drop-shadow(0 0.16cqw 0 #0b0614)
    drop-shadow(0 -0.16cqw 0 #0b0614);
}
.left .choice-text {
  left: 52.9%;
  top: 27.4%;
  background-image: linear-gradient(180deg, #fff6a0 0%, #ffc21a 50%, #ff8a1a 100%);
}
.right .choice-text {
  left: 47.4%;
  top: 27.9%;
  background-image: linear-gradient(180deg, #ffffff 0%, #ffb8ea 50%, #ff2ea8 100%);
}
/* VS in the middle of the divider */
.vs-badge {
  position: absolute;
  left: 50%;
  top: 25.8cqw;
  z-index: 5;
  width: 17cqw;
  height: 11cqw;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  pointer-events: none;
  animation: vs-slam 0.5s cubic-bezier(0.2, 1.8, 0.4, 1) 0.2s both;
}
.vs-burst {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  fill: #fff27a;
  stroke: #ff2ea8;
  stroke-width: 1.4;
  filter: drop-shadow(0 0 1cqw rgba(255, 210, 31, 0.8));
}
.vs-text {
  position: relative;
  font-size: 6.5cqw;
  transform: rotate(-6deg) skewX(-8deg);
  background-image: linear-gradient(180deg, #fff6a0 0%, #ffc21a 45%, #ff6a1a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0.25cqw 0 0 #ff2ea8) drop-shadow(-0.25cqw 0 0 #ff2ea8) drop-shadow(0 0.25cqw 0 #ff2ea8)
    drop-shadow(0 -0.25cqw 0 #ff2ea8) drop-shadow(0.3cqw 0.3cqw 0 #0b0614);
}
@keyframes choice-in {
  from {
    opacity: 0;
    transform: scale(1.6);
  }
}
@keyframes vs-slam {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(3) rotate(-15deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .stage-panel,
  .player-tag,
  .name-wrap,
  .info {
    transition: none;
  }
  .choice-wrap,
  .vs-badge {
    animation: none;
  }
}
</style>
