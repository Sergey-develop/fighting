import { TICK_MS } from './config'

export interface LoopCallbacks {
  /** called once per render frame before simulation steps (input polling) */
  beginFrame(): void
  /** one fixed simulation step */
  step(): void
  /** online: false while the next step must wait (opponent's input not here yet) */
  canStep?(): boolean
  /** draw; alpha is the interpolation factor between the last two steps */
  render(alpha: number): void
}

/**
 * Fixed-timestep loop: simulation always advances in TICK_MS steps regardless
 * of the display refresh rate, so frame data (startup/active/recovery) is
 * deterministic. Rendering runs on requestAnimationFrame.
 */
export class FixedLoop {
  private accumulator = 0
  private last = 0
  private rafId = 0
  private running = false
  /** < 1 slows the simulation down (KO slow motion); steps stay fixed */
  timeScale = 1
  paused = false

  private static readonly MAX_STEPS_PER_FRAME = 5

  constructor(private readonly callbacks: LoopCallbacks) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.accumulator = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return
    let dt = now - this.last
    this.last = now
    // tab switches etc. — never try to catch up more than a few steps
    if (dt > 250) dt = TICK_MS
    this.callbacks.beginFrame()
    if (!this.paused) {
      this.accumulator += dt * this.timeScale
      let steps = 0
      while (this.accumulator >= TICK_MS && steps < FixedLoop.MAX_STEPS_PER_FRAME) {
        if (this.callbacks.canStep && !this.callbacks.canStep()) {
          // stalled: don't bank time, or the game would fast-forward afterwards
          this.accumulator = Math.min(this.accumulator, TICK_MS)
          break
        }
        this.callbacks.step()
        this.accumulator -= TICK_MS
        steps++
      }
      if (steps === FixedLoop.MAX_STEPS_PER_FRAME) this.accumulator = 0
    }
    this.callbacks.render(this.paused ? 1 : this.accumulator / TICK_MS)
    this.rafId = requestAnimationFrame(this.frame)
  }
}
