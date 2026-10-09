<script setup lang="ts">
import { computed, watch } from 'vue'
import { audioManager } from './game/audio/audio-manager'
import { sceneImageUrl } from './game/locations/locations'
import { app } from './ui/store'
import MainMenu from './ui/screens/MainMenu.vue'
import OnlineLobby from './ui/screens/OnlineLobby.vue'
import CharacterSelect from './ui/screens/CharacterSelect.vue'
import LocationSelect from './ui/screens/LocationSelect.vue'
import VersusScreen from './ui/screens/VersusScreen.vue'
import FightScreen from './ui/screens/FightScreen.vue'
import ResultScreen from './ui/screens/ResultScreen.vue'
import ControlsScreen from './ui/screens/ControlsScreen.vue'
import SettingsScreen from './ui/screens/SettingsScreen.vue'

const scene = sceneImageUrl()
const stageStyle = computed(() => (scene ? { backgroundImage: `url("${scene}")` } : {}))

watch(
  () => app.screen,
  (s) => {
    // VS and fight screens start their own tracks
    if (s !== 'fight' && s !== 'versus') audioManager.playMusic('menu')
  },
  { immediate: true },
)
</script>

<template>
  <div class="stage" :style="stageStyle">
    <MainMenu v-if="app.screen === 'menu'" />
    <OnlineLobby v-else-if="app.screen === 'online'" />
    <CharacterSelect v-else-if="app.screen === 'select'" />
    <LocationSelect v-else-if="app.screen === 'location'" />
    <VersusScreen v-else-if="app.screen === 'versus'" />
    <FightScreen v-else-if="app.screen === 'fight'" :key="app.fightSerial" />
    <ResultScreen v-else-if="app.screen === 'result'" />
    <ControlsScreen v-else-if="app.screen === 'controls'" />
    <SettingsScreen v-else-if="app.screen === 'settings'" />
  </div>
  <div class="rotate-hint">
    <div class="phone">📱</div>
    <p>Поверните телефон горизонтально</p>
  </div>
</template>

<style scoped>
.rotate-hint {
  display: none;
}
/* phones held upright: the 16:9 stage would be a thin strip */
@media (orientation: portrait) and (pointer: coarse) {
  .rotate-hint {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6vw;
    padding: 8vw;
    background: #120a24;
    color: #fff;
    font-size: 4.5vw;
    line-height: 1.6;
    text-align: center;
  }
  .phone {
    font-size: 20vw;
    animation: turn 1.6s ease-in-out infinite;
  }
}
@keyframes turn {
  0%,
  30% {
    transform: rotate(0deg);
  }
  60%,
  100% {
    transform: rotate(-90deg);
  }
}
</style>
