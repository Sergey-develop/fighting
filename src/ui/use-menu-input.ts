import { onBeforeUnmount, onMounted } from 'vue'
import { audioManager } from '@/game/audio/audio-manager'
import { inputManager } from '@/game/input/input-manager'

export interface MenuFrame {
  /** menu actions from any device */
  any: number
  /** menu actions per player seat (their assigned device) */
  players: [number, number]
  /** pad index with any button pressed this frame (-1 = none) */
  padPressed: number
}

/**
 * Polls devices once per animation frame while a menu screen is mounted.
 * Only one menu loop should be active at a time.
 */
export function useMenuInput(handler: (frame: MenuFrame) => void): void {
  let raf = 0
  const frame: MenuFrame = { any: 0, players: [0, 0], padPressed: -1 }
  const tick = (): void => {
    inputManager.poll()
    if (!inputManager.capturing) {
      frame.any = inputManager.readMenuAny()
      frame.players[0] = inputManager.readMenu(0)
      frame.players[1] = inputManager.readMenu(1)
      frame.padPressed = inputManager.padWithAnyPress()
      if (frame.any || frame.padPressed >= 0) audioManager.unlock()
      handler(frame)
    }
    inputManager.endTick()
    raf = requestAnimationFrame(tick)
  }
  onMounted(() => {
    raf = requestAnimationFrame(tick)
  })
  onBeforeUnmount(() => cancelAnimationFrame(raf))
}
