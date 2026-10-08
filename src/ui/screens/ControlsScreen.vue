<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { PLAYER_SLOTS, otherSlot, type PlayerSlot } from '@/game/core/types'
import {
  ACTION_LABEL,
  REBINDABLE_ACTIONS,
  hasMenu,
  type InputAction,
} from '@/game/input/actions'
import {
  defaultGamepadBindings,
  defaultKeyboardBindings,
  gamepadCodeLabel,
  keyCodeLabel,
  type ControlsConfig,
  type DeviceRef,
} from '@/game/input/bindings'
import { inputManager, type GamepadInfo } from '@/game/input/input-manager'
import { app, go, saveControls } from '../store'
import { useMenuInput } from '../use-menu-input'

type Column = 'keyboard' | 'gamepad'

/** reactive mirror of inputManager.controls, written back on every change */
const controls = reactive(structuredClone(inputManager.controls))
const pads = ref<GamepadInfo[]>(inputManager.listGamepads())
const unsubscribe = inputManager.onDevicesChanged(() => {
  pads.value = inputManager.listGamepads()
})
onBeforeUnmount(() => {
  unsubscribe()
  inputManager.cancelCapture()
})

const capturing = ref<{ slot: PlayerSlot; action: InputAction; column: Column } | null>(null)
const message = ref('')

function commit(): void {
  // reactive proxies cannot go through structuredClone; the config is plain JSON data
  inputManager.controls = JSON.parse(JSON.stringify(controls)) as ControlsConfig
  saveControls()
}

// ---------------------------------------------------------------- devices

interface DeviceOption {
  label: string
  ref: DeviceRef
}

const deviceOptions = computed<DeviceOption[]>(() => [
  { label: 'Клавиатура', ref: { kind: 'keyboard' } },
  ...pads.value.map((p) => ({ label: `Геймпад ${p.index + 1}`, ref: { kind: 'gamepad', index: p.index, id: p.id } as DeviceRef })),
  { label: 'Нет', ref: { kind: 'none' } },
])

function sameDevice(a: DeviceRef, b: DeviceRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'gamepad' && b.kind === 'gamepad') return a.index === b.index
  return true
}

function deviceName(d: DeviceRef): string {
  if (d.kind === 'keyboard') return 'Клавиатура'
  if (d.kind === 'none') return 'Нет'
  const connected = pads.value.some((p) => p.index === d.index)
  return `Геймпад ${d.index + 1}${connected ? '' : ' (не подключён)'}`
}

function setDevice(slot: PlayerSlot, d: DeviceRef): void {
  const other = controls.players[otherSlot(slot)].device
  if (d.kind === 'gamepad' && sameDevice(other, d)) {
    // swap: one gamepad cannot drive both players
    controls.players[otherSlot(slot)].device = controls.players[slot].device
  }
  controls.players[slot].device = d
  commit()
  audioManager.play('ui-move')
}

function cycleDevice(slot: PlayerSlot): void {
  const opts = deviceOptions.value
  const i = opts.findIndex((o) => sameDevice(o.ref, controls.players[slot].device))
  const next = opts[(i + 1) % opts.length]
  if (next) setDevice(slot, next.ref)
}

// --------------------------------------------------------------- bindings

function labels(slot: PlayerSlot, action: InputAction, column: Column): string {
  const pc = controls.players[slot]
  const list = column === 'keyboard' ? pc.keyboard[action].map(keyCodeLabel) : pc.gamepad[action].map(gamepadCodeLabel)
  return list.length ? list.join(' / ') : '—'
}

async function rebind(slot: PlayerSlot, action: InputAction, column: Column): Promise<void> {
  if (capturing.value) return
  capturing.value = { slot, action, column }
  message.value = column === 'keyboard' ? 'Нажмите клавишу (Esc — отмена)' : 'Нажмите кнопку на геймпаде (Esc — отмена)'
  const pc = controls.players[slot]
  if (column === 'keyboard') {
    const code = await inputManager.captureKey()
    if (code) {
      for (const a of REBINDABLE_ACTIONS) pc.keyboard[a] = pc.keyboard[a].filter((c) => c !== code)
      const rest = pc.keyboard[action].slice(1)
      pc.keyboard[action] = [code, ...rest.filter((c) => c !== code)]
      const otherKb = controls.players[otherSlot(slot)].keyboard
      const clash = REBINDABLE_ACTIONS.find((a) => otherKb[a].includes(code))
      message.value = clash ? `Внимание: ${keyCodeLabel(code)} также назначена игроку ${otherSlot(slot) + 1} (${ACTION_LABEL[clash]})` : ''
      if (clash) {
        const shown = message.value
        window.setTimeout(() => {
          if (message.value === shown) message.value = ''
        }, 2500)
      }
    } else message.value = ''
  } else {
    const d = pc.device
    const padIndex = d.kind === 'gamepad' ? inputManager.resolvePad(d) : null
    const code = await inputManager.captureGamepad(padIndex !== null && padIndex >= 0 ? padIndex : null)
    if (code !== null) {
      for (const a of REBINDABLE_ACTIONS) pc.gamepad[a] = pc.gamepad[a].filter((c) => c !== code)
      const rest = pc.gamepad[action].slice(1)
      pc.gamepad[action] = [code, ...rest.filter((c) => c !== code)]
    }
    message.value = ''
  }
  capturing.value = null
  commit()
  audioManager.play('ui-confirm')
}

function resetPlayer(slot: PlayerSlot): void {
  controls.players[slot].keyboard = defaultKeyboardBindings(slot)
  controls.players[slot].gamepad = defaultGamepadBindings()
  commit()
  audioManager.play('ui-back')
}

function back(): void {
  audioManager.play('ui-back')
  go(app.returnTo === 'controls' ? 'menu' : app.returnTo)
}

// ---------------------------------------------------- keyboard/pad focus
// rows: 0 = device, 1..n = actions, n+1 = reset; columns: P1 kb, P1 pad, P2 kb, P2 pad

const focus = reactive({ row: 1, col: 0 })
const rowCount = REBINDABLE_ACTIONS.length + 2

function focusSlot(): PlayerSlot {
  return focus.col < 2 ? 0 : 1
}

function focusColumn(): Column {
  return focus.col % 2 === 0 ? 'keyboard' : 'gamepad'
}

function isFocused(slot: PlayerSlot, row: number, column?: Column): boolean {
  if (focusSlot() !== slot || focus.row !== row) return false
  return column === undefined || focusColumn() === column
}

useMenuInput(({ any }) => {
  if (capturing.value) return
  if (hasMenu(any, 'up')) focus.row = (focus.row + rowCount - 1) % rowCount
  if (hasMenu(any, 'down')) focus.row = (focus.row + 1) % rowCount
  if (hasMenu(any, 'left')) focus.col = (focus.col + 3) % 4
  if (hasMenu(any, 'right')) focus.col = (focus.col + 1) % 4
  if (hasMenu(any, 'back')) back()
  if (hasMenu(any, 'confirm')) {
    const slot = focusSlot()
    if (focus.row === 0) cycleDevice(slot)
    else if (focus.row === rowCount - 1) resetPlayer(slot)
    else {
      const action = REBINDABLE_ACTIONS[focus.row - 1]
      if (action) void rebind(slot, action, focusColumn())
    }
  }
})
</script>

<template>
  <div class="screen dim controls">
    <h1 class="title head">УПРАВЛЕНИЕ</h1>
    <div class="players">
      <section v-for="slot in PLAYER_SLOTS" :key="slot" class="panel player" :class="slot === 0 ? 'p1' : 'p2'">
        <h2>PLAYER {{ slot + 1 }}</h2>
        <div class="device-row" :class="{ focused: isFocused(slot, 0) }">
          <span class="label">Устройство</span>
          <div class="chips">
            <button
              v-for="opt in deviceOptions"
              :key="opt.label"
              class="chip"
              :class="{ on: sameDevice(opt.ref, controls.players[slot].device) }"
              @click="setDevice(slot, opt.ref)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div class="current hint">Сейчас: {{ deviceName(controls.players[slot].device) }}</div>
        <table>
          <thead>
            <tr>
              <th>Действие</th>
              <th>Клавиатура</th>
              <th>Геймпад</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(action, i) in REBINDABLE_ACTIONS" :key="action">
              <td>{{ ACTION_LABEL[action] }}</td>
              <td>
                <button
                  class="bind"
                  :class="{
                    focused: isFocused(slot, i + 1, 'keyboard'),
                    wait: capturing?.slot === slot && capturing.action === action && capturing.column === 'keyboard',
                  }"
                  @click="rebind(slot, action, 'keyboard')"
                >
                  {{ labels(slot, action, 'keyboard') }}
                </button>
              </td>
              <td>
                <button
                  class="bind"
                  :class="{
                    focused: isFocused(slot, i + 1, 'gamepad'),
                    wait: capturing?.slot === slot && capturing.action === action && capturing.column === 'gamepad',
                  }"
                  @click="rebind(slot, action, 'gamepad')"
                >
                  {{ labels(slot, action, 'gamepad') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <button class="btn ghost reset" :class="{ focused: isFocused(slot, rowCount - 1) }" @click="resetPlayer(slot)">
          Сбросить
        </button>
      </section>
    </div>
    <div class="footer">
      <button class="btn pink" @click="back">Назад</button>
    </div>
    <div v-if="message" class="message panel">{{ message }}</div>
  </div>
</template>

<style scoped>
.controls {
  padding: 1.5cqw 2cqw;
  gap: 1cqw;
}
.head {
  position: relative;
  font-size: 2.4cqw;
  margin: 0;
}
.players {
  position: relative;
  display: flex;
  gap: 2cqw;
  width: 100%;
  flex: 1;
  min-height: 0;
}
.player {
  flex: 1;
  padding: 1.2cqw 1.5cqw;
  display: flex;
  flex-direction: column;
  gap: 0.6cqw;
}
.player.p1 {
  border-color: var(--p1);
}
.player.p2 {
  border-color: var(--p2);
}
.player h2 {
  margin: 0;
  font-size: 1.2cqw;
}
.p1 h2 {
  color: var(--p1);
}
.p2 h2 {
  color: var(--p2);
}
.device-row {
  display: flex;
  align-items: center;
  gap: 1cqw;
  padding: 0.3cqw;
}
.device-row.focused {
  outline: 0.2cqw solid #fff;
}
.label {
  font-size: 0.7cqw;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5cqw;
}
.chip {
  font-family: var(--font);
  font-size: 0.6cqw;
  padding: 0.5cqw 0.8cqw;
  background: var(--panel-2);
  color: #fff;
  border: 0.15cqw solid rgba(255, 255, 255, 0.3);
  cursor: pointer;
}
.p1 .chip.on {
  background: var(--p1);
  color: var(--ink);
}
.p2 .chip.on {
  background: var(--p2);
}
.current {
  text-align: left;
  font-size: 0.6cqw;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.65cqw;
}
th {
  text-align: left;
  color: var(--muted);
  font-weight: normal;
  padding: 0.3cqw;
}
td {
  padding: 0.2cqw 0.3cqw;
  border-top: 0.1cqw solid rgba(255, 255, 255, 0.08);
}
.bind {
  width: 100%;
  font-family: var(--font);
  font-size: 0.65cqw;
  padding: 0.45cqw;
  background: var(--ink);
  color: #fff;
  border: 0.15cqw solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  text-align: left;
}
.bind:hover,
.bind.focused {
  border-color: #fff;
}
.bind.wait {
  background: var(--p2);
  animation: pulse 0.6s ease-in-out infinite alternate;
}
.reset {
  align-self: flex-start;
  font-size: 0.7cqw;
  min-width: 0;
  padding: 0.6cqw 1.4cqw;
}
.footer {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2cqw;
  width: 100%;
}
.message {
  position: absolute;
  top: 45%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 2cqw 3cqw;
  font-size: 1cqw;
  border-color: var(--p2);
  max-width: 60cqw;
  text-align: center;
  line-height: 1.6;
}
@keyframes pulse {
  to {
    filter: brightness(1.4);
  }
}
</style>
