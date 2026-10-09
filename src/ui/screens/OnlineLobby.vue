<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { hasMenu } from '@/game/input/actions'
import { net, normalizeRoomCode } from '@/game/net/connection'
import { leaveOnline, online } from '../store'
import { useMenuInput } from '../use-menu-input'

/** shown in the corner: tells at a glance whether a player has a stale page */
const BUILD = __BUILD_TIME__

const codeInput = ref('')
const input = ref<HTMLInputElement | null>(null)
const copied = ref(false)

const busy = computed(() => online.status === 'opening' || online.status === 'connecting' || online.status === 'waiting')
const canJoin = computed(() => normalizeRoomCode(codeInput.value).length >= 4 && !busy.value)

const statusText = computed(() => {
  switch (online.status) {
    case 'opening':
      return 'Подключение к серверу...'
    case 'waiting':
      return 'Ждём соперника...'
    case 'connecting':
      return `Подключаемся к комнате ${online.code}...`
    case 'connected':
      return 'Соединение установлено!'
    default:
      return ''
  }
})

function create(): void {
  audioManager.play('ui-confirm')
  copied.value = false
  net.host()
}

function join(): void {
  if (!canJoin.value) return
  audioManager.play('ui-confirm')
  net.join(codeInput.value)
}

function cancel(): void {
  audioManager.play('ui-back')
  net.leave()
}

function back(): void {
  audioManager.play('ui-back')
  leaveOnline()
}

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(online.code)
    copied.value = true
  } catch {
    copied.value = false
  }
}

function onCodeInput(): void {
  codeInput.value = normalizeRoomCode(codeInput.value).slice(0, 8)
}

void nextTick(() => input.value?.focus())

useMenuInput(({ any }) => {
  // typing a code must not trigger menu actions
  if (document.activeElement === input.value) return
  if (hasMenu(any, 'back')) {
    if (busy.value) cancel()
    else back()
  }
})
</script>

<template>
  <div class="screen dim lobby">
    <h1 class="title heading">ОНЛАЙН</h1>

    <div class="cards">
      <section class="panel card host">
        <h2>Создать комнату</h2>
        <template v-if="online.role === 'host' && (online.status === 'waiting' || online.status === 'opening')">
          <p class="label">Код комнаты — отправьте его сопернику:</p>
          <button class="code" :disabled="online.status !== 'waiting'" title="Скопировать" @click="copyCode">
            {{ online.status === 'waiting' ? online.code : '·····' }}
          </button>
          <p class="hint small">{{ copied ? 'Скопировано!' : 'Нажмите на код, чтобы скопировать' }}</p>
          <button class="btn ghost" @click="cancel">Отмена</button>
        </template>
        <template v-else>
          <p class="label">Вы будете Игроком 1 и выберете локацию.</p>
          <button class="btn" :disabled="busy" @click="create">Создать</button>
        </template>
      </section>

      <section class="panel card guest">
        <h2>Войти по коду</h2>
        <p class="label">Введите код, который прислал соперник:</p>
        <input
          ref="input"
          v-model="codeInput"
          class="code-input"
          maxlength="8"
          placeholder="ABCDE"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @input="onCodeInput"
          @keydown.enter="join"
          @keydown.esc="input?.blur()"
        />
        <button v-if="online.role === 'guest' && online.status === 'connecting'" class="btn ghost" @click="cancel">
          Отмена
        </button>
        <button v-else class="btn pink" :disabled="!canJoin" @click="join">Подключиться</button>
      </section>
    </div>

    <p v-if="statusText" class="status">{{ statusText }}</p>
    <p v-if="online.error" class="error">{{ online.error }}</p>
    <p v-if="busy && online.diag" class="hint small diag">{{ online.diag }}</p>

    <p class="hint note">
      Игра идёт напрямую между браузерами. Оба играют своими кнопками Игрока 1 (или любым геймпадом).
    </p>
    <button class="btn ghost back" @click="back">Назад</button>
    <span class="build">сборка {{ BUILD }}</span>
  </div>
</template>

<style scoped>
.lobby {
  justify-content: center;
  gap: 2cqw;
}
.heading {
  position: relative;
  font-size: 5cqw;
  margin: 0;
  transform: rotate(-3deg);
}
.cards {
  position: relative;
  display: flex;
  gap: 3cqw;
}
.card {
  width: 30cqw;
  padding: 2cqw;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2cqw;
  text-align: center;
}
.card.host {
  border-color: var(--p1);
}
.card.guest {
  border-color: var(--p2);
}
.card h2 {
  font-size: 1.3cqw;
  margin: 0;
}
.host h2 {
  color: var(--p1);
}
.guest h2 {
  color: var(--p2);
}
.label {
  font-size: 0.8cqw;
  line-height: 1.6;
  margin: 0;
}
.code {
  font: inherit;
  font-size: 3.2cqw;
  letter-spacing: 0.6cqw;
  color: var(--p1);
  background: rgba(0, 0, 0, 0.45);
  border: 0.2cqw dashed var(--p1);
  padding: 0.8cqw 1.6cqw;
  cursor: pointer;
}
.code:disabled {
  cursor: default;
  opacity: 0.6;
}
.code-input {
  font: inherit;
  font-size: 2.4cqw;
  letter-spacing: 0.5cqw;
  text-align: center;
  text-transform: uppercase;
  width: 22cqw;
  padding: 0.8cqw;
  color: var(--p2);
  background: rgba(0, 0, 0, 0.45);
  border: 0.2cqw solid var(--p2);
  outline: none;
}
.code-input:focus {
  box-shadow: 0 0 1.2cqw var(--p2);
}
.code-input::placeholder {
  color: rgba(255, 255, 255, 0.2);
}
.small {
  font-size: 0.65cqw;
  margin: 0;
}
.status {
  position: relative;
  font-size: 1cqw;
  margin: 0;
  animation: blink 1.2s ease-in-out infinite;
}
.error {
  position: relative;
  font-size: 0.9cqw;
  color: var(--danger);
  margin: 0;
}
.note {
  position: relative;
  max-width: 60cqw;
  text-align: center;
  line-height: 1.6;
}
.diag {
  position: relative;
}
.build {
  position: absolute;
  right: 2cqw;
  bottom: 2cqw;
  font-size: 0.6cqw;
  color: var(--muted);
}
.back {
  position: absolute;
  left: 2cqw;
  bottom: 2cqw;
}
@keyframes blink {
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .status {
    animation: none;
  }
}
</style>
