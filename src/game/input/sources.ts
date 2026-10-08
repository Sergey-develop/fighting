import type { PlayerSlot } from '../core/types'
import type { InputFrame } from './actions'
import type { InputManager } from './input-manager'

/**
 * Anything that can drive a fighter: a physical device or the AI.
 * The fighter controller cannot tell them apart.
 */
export interface InputSource {
  readonly kind: 'device' | 'ai'
  /** Fill `out` with this tick's input. */
  readTick(out: InputFrame): void
}

/** Player 1 against the AI: keyboard and any gamepad drive the same fighter. */
export class AnyDeviceInputSource implements InputSource {
  readonly kind = 'device'

  constructor(
    private readonly manager: InputManager,
    private readonly slot: PlayerSlot,
  ) {}

  readTick(out: InputFrame): void {
    this.manager.readPlayerAnyDevice(this.slot, out)
  }
}

export class DeviceInputSource implements InputSource {
  readonly kind = 'device'

  constructor(
    private readonly manager: InputManager,
    private readonly slot: PlayerSlot,
  ) {}

  readTick(out: InputFrame): void {
    this.manager.readPlayer(this.slot, out)
  }
}
