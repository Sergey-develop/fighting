<script setup lang="ts">
import { computed, watch } from 'vue'
import { audioManager } from './game/audio/audio-manager'
import { sceneImageUrl } from './game/locations/locations'
import { app } from './ui/store'
import MainMenu from './ui/screens/MainMenu.vue'
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
    <CharacterSelect v-else-if="app.screen === 'select'" />
    <LocationSelect v-else-if="app.screen === 'location'" />
    <VersusScreen v-else-if="app.screen === 'versus'" />
    <FightScreen v-else-if="app.screen === 'fight'" :key="app.fightSerial" />
    <ResultScreen v-else-if="app.screen === 'result'" />
    <ControlsScreen v-else-if="app.screen === 'controls'" />
    <SettingsScreen v-else-if="app.screen === 'settings'" />
  </div>
</template>
