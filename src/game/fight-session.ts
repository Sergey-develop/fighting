import { AiController } from './ai/ai-controller'
import { loadAtlas, type SpriteAtlas } from './assets/atlas'
import { audioManager } from './audio/audio-manager'
import { HudBridge } from './bridge/hud-bridge'
import { CombatSystem } from './combat/combat-system'
import { Fighter } from './combat/fighter'
import { COMBAT_CONFIG } from './core/config'
import { EventQueue } from './core/events'
import { FixedLoop } from './core/loop'
import { PLAYER_SLOTS, type PlayerSlot } from './core/types'
import { getFighter, validateFighter } from './fighters/registry'
import { ACTION_BIT, createInputFrame, type InputFrame } from './input/actions'
import type { InputManager } from './input/input-manager'
import { AnyDeviceInputSource, DeviceInputSource, type InputSource } from './input/sources'
import { FighterFx } from './render/fighter-fx'
import { Renderer } from './render/renderer'
import { Match, type MatchPhase } from './rounds/match'
import { VfxSystem } from './vfx/vfx'

export type GameMode = 'versus' | 'ai'

export interface FightSetup {
  mode: GameMode
  fighters: [string, string]
  roundTimeSeconds: number
  showHitboxes: boolean
  /** arena background image (null = gradient) */
  stageImage: string | null
}

export interface MatchSummary {
  winner: PlayerSlot
  wins: [number, number]
  fighters: [string, string]
  mode: GameMode
}

/** Ticks the MATCH_END banner stays before the result screen. */
const MATCH_END_HOLD = 90

/**
 * One fight: wires input sources → combat → rounds → vfx/audio → renderer
 * inside a fixed-timestep loop. Vue only creates it, reads the HUD bridge and
 * calls pause/resume/destroy.
 */
export class FightSession {
  readonly hud = new HudBridge()
  readonly fighters: [Fighter, Fighter]
  private readonly combat: CombatSystem
  private readonly match: Match
  private readonly events = new EventQueue()
  private readonly vfx = new VfxSystem()
  private readonly fx: [FighterFx, FighterFx] = [new FighterFx(), new FighterFx()]
  /** 0..1 stage darkening while a special charges */
  private superDim = 0
  private readonly renderer: Renderer
  private readonly loop: FixedLoop
  private readonly sources: [InputSource, InputSource]
  private readonly ai: AiController | null
  private readonly inputs: [InputFrame, InputFrame] = [createInputFrame(), createInputFrame()]
  private readonly pauseProbe: InputFrame = createInputFrame()
  private tick = 0
  private lastPhaseSerial = -1
  private matchEndTicks = 0
  private finished = false
  private userPaused = false
  onMatchEnd: ((summary: MatchSummary) => void) | null = null

  static async create(canvas: HTMLCanvasElement, setup: FightSetup, input: InputManager): Promise<FightSession> {
    const defs = [getFighter(setup.fighters[0]), getFighter(setup.fighters[1])] as const
    const atlases = (await Promise.all(defs.map((d) => loadAtlas(d.assetDir)))) as [SpriteAtlas, SpriteAtlas]
    defs.forEach((d, i) => {
      const problems = validateFighter(d, atlases[i] as SpriteAtlas)
      if (problems.length) throw new Error(`Fighter definition errors:\n${problems.join('\n')}`)
    })
    return new FightSession(canvas, setup, input, atlases)
  }

  private constructor(
    canvas: HTMLCanvasElement,
    private readonly setup: FightSetup,
    private readonly input: InputManager,
    atlases: [SpriteAtlas, SpriteAtlas],
  ) {
    const a = new Fighter(getFighter(setup.fighters[0]), 0)
    const b = new Fighter(getFighter(setup.fighters[1]), 1)
    this.fighters = [a, b]
    this.combat = new CombatSystem(this.fighters, this.events)
    this.match = new Match(this.fighters, this.combat, {
      roundTimeSeconds: setup.roundTimeSeconds,
      roundsToWin: COMBAT_CONFIG.rounds.roundsToWin,
    })
    this.renderer = new Renderer(canvas, atlases, setup.stageImage)
    this.renderer.options.showHitboxes = setup.showHitboxes
    this.ai = setup.mode === 'ai' ? new AiController(b, a) : null
    this.sources = this.ai
      ? [new AnyDeviceInputSource(input, 0), this.ai]
      : [new DeviceInputSource(input, 0), new DeviceInputSource(input, 1)]
    this.loop = new FixedLoop({
      beginFrame: () => this.beginFrame(),
      step: () => this.step(),
      render: (alpha) => this.render(alpha),
    })
    const s = this.hud.snapshot
    PLAYER_SLOTS.forEach((slot) => {
      const f = this.fighters[slot]
      const h = s.fighters[slot]
      h.name = f.def.name
      h.maxHp = f.def.stats.maxHp
      h.energyMax = COMBAT_CONFIG.energy.max
      h.specialCost = f.def.special.energyCost
    })
    s.roundsToWin = COMBAT_CONFIG.rounds.roundsToWin
  }

  start(): void {
    this.match.startMatch()
    this.loop.start()
  }

  destroy(): void {
    this.loop.stop()
    this.onMatchEnd = null
  }

  setPaused(paused: boolean): void {
    this.userPaused = paused
    this.updatePause()
  }

  get paused(): boolean {
    return this.loop.paused
  }

  private updatePause(): void {
    const s = this.hud.snapshot
    const disconnected = s.disconnected[0] || s.disconnected[1]
    this.loop.paused = this.userPaused || disconnected
    s.paused = this.loop.paused
  }

  // ---------------------------------------------------------------- frame

  private updateDisconnected(): void {
    const s = this.hud.snapshot
    for (const slot of PLAYER_SLOTS) {
      // vs AI player 1 uses every device, so nothing can go missing
      const missing =
        this.setup.mode === 'versus' && !this.input.isSeatConnected(slot)
      // a controller unplugged mid-fight pauses the game; the player resumes manually
      if (missing && !s.disconnected[slot]) this.userPaused = true
      s.disconnected[slot] = missing
    }
  }

  private beginFrame(): void {
    if (this.loop.paused) {
      // while paused the Vue pause menu owns input polling
      this.updateDisconnected()
      this.updatePause()
      return
    }
    this.input.poll()
    this.updateDisconnected()
    let pausePressed = false
    for (const slot of PLAYER_SLOTS) {
      if (this.sources[slot].kind !== 'device') continue
      if (this.setup.mode === 'ai') this.input.readPlayerAnyDevice(slot, this.pauseProbe)
      else this.input.readPlayer(slot, this.pauseProbe)
      if (this.pauseProbe.pressed & ACTION_BIT.pause) pausePressed = true
    }
    if (pausePressed && !this.finished) this.userPaused = true
    this.updatePause()
    if (this.loop.paused) this.input.endTick()
  }

  private step(): void {
    this.ai?.observe()
    this.sources[0].readTick(this.inputs[0])
    this.sources[1].readTick(this.inputs[1])
    this.input.endTick()

    this.events.clear()
    this.combat.step(this.inputs, this.tick)
    this.match.step()
    this.vfx.update()
    this.fx[0].update(this.fighters[0], this.vfx)
    this.fx[1].update(this.fighters[1], this.vfx)
    const [fa, fb] = this.fighters
    const charging =
      (fa.state === 'SPECIAL' && fa.attackPhase !== 'recovery') || (fb.state === 'SPECIAL' && fb.attackPhase !== 'recovery')
    this.superDim += ((charging ? 1 : 0) - this.superDim) * 0.2
    this.handleEvents()
    this.handlePhase()
    this.loop.timeScale = this.match.timeScale
    this.tick++
  }

  private handleEvents(): void {
    const s = this.hud.snapshot
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events.at(i)
      const attacker = this.fighters[e.slot]
      switch (e.type) {
        case 'attack':
          audioManager.play(e.sound)
          break
        case 'jump':
          audioManager.play('jump')
          break
        case 'land':
          audioManager.play('land')
          break
        case 'hit':
          audioManager.play(e.sound)
          this.vfx.hit(e.x, e.y, e.impact, e.color, attacker.facing, e.shake)
          break
        case 'guardBreak':
          audioManager.play('guard-break')
          audioManager.play(e.sound)
          this.vfx.hit(e.x, e.y, e.impact, e.color, attacker.facing, e.shake)
          s.fighters[e.slot].guardBreakSerial++
          break
        case 'block':
          audioManager.play('block')
          this.vfx.block(e.x, e.y)
          break
        case 'ko':
          audioManager.play('ko')
          this.vfx.ko()
          break
        case 'energyDenied':
          s.fighters[e.slot].energyDeniedSerial++
          break
        case 'comboFinisher':
          s.fighters[e.slot].comboFinisherSerial++
          break
      }
    }
  }

  private handlePhase(): void {
    const m = this.match
    if (m.phaseSerial !== this.lastPhaseSerial) {
      this.lastPhaseSerial = m.phaseSerial
      const phase: MatchPhase = m.phase
      if (phase === 'READY') {
        this.vfx.clear()
        this.fx[0].reset()
        this.fx[1].reset()
        this.superDim = 0
        audioManager.play('round')
        // every round (also after a rematch / restart) starts the fight track from the top;
        // coming from the VS sting it crossfades
        audioManager.playMusic('fight', { restart: true })
      } else if (phase === 'FIGHT_TEXT') audioManager.play('fight')
    }
    if (m.phase === 'MATCH_END' && !this.finished) {
      this.matchEndTicks++
      if (this.matchEndTicks >= MATCH_END_HOLD && m.matchWinner !== null) {
        this.finished = true
        const summary: MatchSummary = {
          winner: m.matchWinner,
          wins: [m.wins[0], m.wins[1]],
          fighters: [...this.setup.fighters],
          mode: this.setup.mode,
        }
        this.onMatchEnd?.(summary)
      }
    }
  }

  // --------------------------------------------------------------- render

  private render(alpha: number): void {
    this.renderer.render(this.fighters, this.vfx, alpha, this.fx, this.superDim)
    const s = this.hud.snapshot
    const m = this.match
    s.timer = m.secondsLeft
    s.round = m.round
    s.phase = m.phase
    s.phaseSerial = m.phaseSerial
    s.roundResult = m.roundResult
    s.matchWinner = m.matchWinner
    for (const slot of PLAYER_SLOTS) {
      const f = this.fighters[slot]
      const h = s.fighters[slot]
      h.hp = f.hp
      h.energy = f.energy
      h.wins = m.wins[slot]
      h.comboHits = f.comboHits
      h.comboDamage = f.comboDamage
      h.comboName = f.lastComboName
      h.mood = f.state === 'KO' ? 'ko' : f.state === 'HIT' || f.hp < f.def.stats.maxHp * 0.25 ? 'hurt' : 'normal'
    }
    this.hud.publish()
  }
}
