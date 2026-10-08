import '@fontsource/press-start-2p/400.css'
import './ui/theme.css'
import { createApp } from 'vue'
import App from './App.vue'
import { audioManager } from './game/audio/audio-manager'
import { inputManager } from './game/input/input-manager'

inputManager.attach()
// browsers only allow audio after a user gesture
const unlock = (): void => audioManager.unlock()
window.addEventListener('pointerdown', unlock)
window.addEventListener('keydown', unlock)

// hover sound for every clickable element (played once per element entered)
const HOVERABLE = 'button, [role="button"]'
let hovered: Element | null = null
document.addEventListener('pointerover', (e) => {
  const target = e.target instanceof Element ? e.target.closest(HOVERABLE) : null
  if (target === hovered) return
  hovered = target
  if (!target || (target instanceof HTMLButtonElement && target.disabled)) return
  audioManager.play('ui-move')
})

createApp(App).mount('#app')
