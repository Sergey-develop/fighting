import { MUSIC_IDS, SOUND_IDS, type MusicId, type SoundId } from './sounds'

/**
 * Sound files are optional. Drop files named after a SoundId into /audio
 * (e.g. audio/hit-light.mp3) or music as audio/music-fight.ogg and they are
 * picked up at build time. Missing sounds fall back to tiny procedural
 * WebAudio blips (can be disabled in settings) — no placeholder files exist.
 */
const files = import.meta.glob<string>('/audio/*.{mp3,ogg,wav,m4a,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
})

function findFile(name: string): string | null {
  for (const [path, url] of Object.entries(files)) {
    const base = path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'))
    // decodeURI: Vite may hand back percent-encoded paths for non-ASCII names
    if (base === name || decodeURIComponent(base) === name) return url
  }
  return null
}

/** Extra accepted file names per sound effect (checked after the id itself). */
const SOUND_FILE_ALIASES: Partial<Record<SoundId, readonly string[]>> = {
  // confirming a choice in any menu (pick, ready, location, menu items)
  'ui-confirm': ['click'],
  // going back / cancelling uses the same click
  'ui-back': ['click'],
  // hovering with the mouse / moving the menu cursor
  'ui-move': ['hover'],
  // heavy attacks (ground and air) of every fighter
  'whiff-heavy': ['hadouken'],
  // any blow that lands (blocked hits keep their own sound)
  'hit-light': ['punch'],
  'hit-heavy': ['punch'],
  'hit-special': ['punch'],
}

const SOUND_URLS: Partial<Record<SoundId, string>> = {}
for (const id of SOUND_IDS) {
  for (const name of [id, ...(SOUND_FILE_ALIASES[id] ?? [])]) {
    const url = findFile(name)
    if (url) {
      SOUND_URLS[id] = url
      break
    }
  }
}
/** Accepted file names (without extension) per track, first match wins. */
const MUSIC_FILE_NAMES: Readonly<Record<MusicId, readonly string[]>> = {
  menu: ['music-menu', 'главное меню'],
  vs: ['music-vs', 'выбор персонажей'],
  fight: ['music-fight', 'бой'],
}

const MUSIC_URLS: Partial<Record<MusicId, string>> = {}
for (const id of MUSIC_IDS) {
  for (const name of MUSIC_FILE_NAMES[id]) {
    const url = findFile(name)
    if (url) {
      MUSIC_URLS[id] = url
      break
    }
  }
}

interface MusicTrack {
  id: MusicId
  source: AudioBufferSourceNode
  gain: GainNode
}

export interface AudioVolumes {
  master: number
  music: number
  sfx: number
  synthFallback: boolean
}

interface Blip {
  type: OscillatorType | 'noise'
  freq: number
  endFreq: number
  duration: number
  gain: number
}

const BLIPS: Readonly<Record<SoundId, Blip>> = {
  'ui-move': { type: 'square', freq: 660, endFreq: 660, duration: 0.04, gain: 0.12 },
  'ui-confirm': { type: 'square', freq: 520, endFreq: 1040, duration: 0.1, gain: 0.14 },
  'ui-back': { type: 'square', freq: 520, endFreq: 260, duration: 0.1, gain: 0.12 },
  jump: { type: 'triangle', freq: 220, endFreq: 520, duration: 0.12, gain: 0.2 },
  land: { type: 'noise', freq: 300, endFreq: 100, duration: 0.06, gain: 0.15 },
  'whiff-light': { type: 'noise', freq: 2200, endFreq: 1200, duration: 0.06, gain: 0.12 },
  'whiff-kick': { type: 'noise', freq: 1600, endFreq: 700, duration: 0.09, gain: 0.14 },
  'whiff-heavy': { type: 'noise', freq: 900, endFreq: 300, duration: 0.16, gain: 0.18 },
  'special-charge': { type: 'sawtooth', freq: 180, endFreq: 900, duration: 0.35, gain: 0.12 },
  'hit-light': { type: 'noise', freq: 1400, endFreq: 400, duration: 0.08, gain: 0.35 },
  'hit-heavy': { type: 'noise', freq: 700, endFreq: 120, duration: 0.18, gain: 0.45 },
  'hit-special': { type: 'noise', freq: 1200, endFreq: 80, duration: 0.35, gain: 0.5 },
  block: { type: 'square', freq: 1300, endFreq: 900, duration: 0.06, gain: 0.15 },
  'guard-break': { type: 'sawtooth', freq: 400, endFreq: 90, duration: 0.25, gain: 0.25 },
  ko: { type: 'sawtooth', freq: 300, endFreq: 40, duration: 0.8, gain: 0.3 },
  round: { type: 'square', freq: 440, endFreq: 440, duration: 0.15, gain: 0.15 },
  fight: { type: 'square', freq: 440, endFreq: 880, duration: 0.25, gain: 0.18 },
}

export class AudioManager {
  private ctx: AudioContext | null = null
  private sfxGain: GainNode | null = null
  private noise: AudioBuffer | null = null
  private readonly buffers = new Map<string, AudioBuffer | 'loading' | 'failed'>()
  private musicBus: GainNode | null = null
  private current: MusicTrack | null = null
  /** what should be playing; survives until the AudioContext is unlocked */
  private wanted: { id: MusicId; loop: boolean } | null = null
  private readonly musicBuffers = new Map<MusicId, Promise<AudioBuffer | null>>()
  private readonly loopPoints = new WeakMap<AudioBuffer, { start: number; end: number }>()
  private readonly musicEndListeners = new Set<(id: MusicId) => void>()
  volumes: AudioVolumes = { master: 0.8, music: 0.5, sfx: 0.8, synthFallback: true }

  /** Create the AudioContext on the first user gesture (autoplay policy). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const Ctor = window.AudioContext
    if (!Ctor) return
    this.ctx = new Ctor()
    this.sfxGain = this.ctx.createGain()
    this.sfxGain.connect(this.ctx.destination)
    this.musicBus = this.ctx.createGain()
    this.musicBus.connect(this.ctx.destination)
    this.applyVolumes()
    // preload real files
    for (const url of Object.values(SOUND_URLS)) if (url) void this.load(url)
    for (const id of MUSIC_IDS) void this.loadMusic(id)
    const w = this.wanted
    if (w) this.playMusic(w.id, { loop: w.loop })
  }

  setVolumes(v: AudioVolumes): void {
    this.volumes = { ...v }
    this.applyVolumes()
  }

  private applyVolumes(): void {
    if (this.sfxGain) this.sfxGain.gain.value = this.volumes.master * this.volumes.sfx
    if (this.musicBus) this.musicBus.gain.value = this.volumes.master * this.volumes.music
  }

  private async load(url: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.buffers.has(url)) return
    this.buffers.set(url, 'loading')
    try {
      const res = await fetch(url)
      const data = await res.arrayBuffer()
      this.buffers.set(url, await ctx.decodeAudioData(data))
    } catch {
      this.buffers.set(url, 'failed')
    }
  }

  play(id: SoundId): void {
    const ctx = this.ctx
    const out = this.sfxGain
    if (!ctx || !out) return
    const url = SOUND_URLS[id]
    if (url) {
      const buf = this.buffers.get(url)
      if (buf instanceof AudioBuffer) {
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(out)
        src.start()
        return
      }
    }
    if (this.volumes.synthFallback) this.blip(BLIPS[id])
  }

  private blip(b: Blip): void {
    const ctx = this.ctx
    const out = this.sfxGain
    if (!ctx || !out) return
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(b.gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + b.duration)
    g.connect(out)
    if (b.type === 'noise') {
      const src = ctx.createBufferSource()
      src.buffer = this.noiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(b.freq, t)
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, b.endFreq), t + b.duration)
      src.connect(filter)
      filter.connect(g)
      src.start(t)
      src.stop(t + b.duration)
    } else {
      const osc = ctx.createOscillator()
      osc.type = b.type
      osc.frequency.setValueAtTime(b.freq, t)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, b.endFreq), t + b.duration)
      osc.connect(g)
      osc.start(t)
      osc.stop(t + b.duration)
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.5)
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    return this.noise
  }

  // ------------------------------------------------------------------ music

  static hasMusic(id: MusicId): boolean {
    return MUSIC_URLS[id] !== undefined
  }

  private loadMusic(id: MusicId): Promise<AudioBuffer | null> {
    const url = MUSIC_URLS[id]
    const ctx = this.ctx
    if (!url || !ctx) return Promise.resolve(null)
    let p = this.musicBuffers.get(id)
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null)
      this.musicBuffers.set(id, p)
    }
    return p
  }

  /** Track length in seconds, or null if there is no playable file. */
  async musicDuration(id: MusicId): Promise<number | null> {
    const buf = await this.loadMusic(id)
    return buf ? buf.duration : null
  }

  /** Called when a non-looping track (e.g. the VS sting) finishes. */
  onMusicEnded(cb: (id: MusicId) => void): () => void {
    this.musicEndListeners.add(cb)
    return () => this.musicEndListeners.delete(cb)
  }

  /**
   * Loop boundaries with the encoder's leading/trailing silence trimmed
   * (MP3 adds padding that would otherwise leave a gap at the loop seam).
   */
  private loopBounds(buf: AudioBuffer): { start: number; end: number } {
    const cached = this.loopPoints.get(buf)
    if (cached) return cached
    const threshold = 0.001 // about -60 dB
    const scan = Math.min(buf.length, Math.floor(buf.sampleRate * 1))
    let first = 0
    let last = buf.length - 1
    const loud = (i: number): boolean => {
      for (let c = 0; c < buf.numberOfChannels; c++) {
        if (Math.abs(buf.getChannelData(c)[i] ?? 0) > threshold) return true
      }
      return false
    }
    while (first < scan && !loud(first)) first++
    while (last > buf.length - scan && !loud(last)) last--
    const bounds =
      first < last ? { start: first / buf.sampleRate, end: (last + 1) / buf.sampleRate } : { start: 0, end: buf.duration }
    this.loopPoints.set(buf, bounds)
    return bounds
  }

  /**
   * Background music. Only plays if a file exists in /audio. Loops seamlessly
   * by default; the 'vs' sting plays once. Switching tracks crossfades.
   */
  playMusic(id: MusicId, opts: { loop?: boolean; restart?: boolean } = {}): void {
    const loop = opts.loop ?? id !== 'vs'
    const restart = opts.restart ?? false
    this.wanted = { id, loop }
    if (!MUSIC_URLS[id]) {
      this.fadeOutMusic(0.6)
      return
    }
    if (this.current?.id === id && !restart) return
    if (!this.ctx) return // starts on unlock
    void this.loadMusic(id).then((buf) => {
      if (!buf || this.wanted?.id !== id) return
      if (this.current?.id === id && !restart) return
      // restarting the same track: short fade instead of a long crossfade with itself
      this.startTrack(id, buf, loop, this.current?.id === id ? 0.25 : 0.6)
    })
  }

  private startTrack(id: MusicId, buf: AudioBuffer, loop: boolean, fadeOut: number): void {
    const ctx = this.ctx
    const bus = this.musicBus
    if (!ctx || !bus) return
    this.fadeOutMusic(fadeOut)
    const t = ctx.currentTime
    const source = ctx.createBufferSource()
    source.buffer = buf
    const gain = ctx.createGain()
    if (loop) {
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(1, t + 0.5)
    } else {
      gain.gain.setValueAtTime(1, t) // stings keep their attack
    }
    source.connect(gain)
    gain.connect(bus)
    let offset = 0
    if (loop) {
      const b = this.loopBounds(buf)
      source.loop = true
      source.loopStart = b.start
      source.loopEnd = b.end
      offset = b.start
    }
    const track: MusicTrack = { id, source, gain }
    source.onended = () => {
      if (this.current === track) {
        this.current = null
        if (this.wanted?.id === id) this.wanted = null
        this.musicEndListeners.forEach((cb) => cb(id))
      }
    }
    source.start(t, offset)
    this.current = track
  }

  private fadeOutMusic(seconds: number): void {
    const ctx = this.ctx
    const track = this.current
    this.current = null
    if (!ctx || !track) return
    const t = ctx.currentTime
    track.gain.gain.cancelScheduledValues(t)
    track.gain.gain.setValueAtTime(track.gain.gain.value, t)
    track.gain.gain.linearRampToValueAtTime(0, t + seconds)
    track.source.stop(t + seconds + 0.05)
  }

  stopMusic(): void {
    this.wanted = null
    this.fadeOutMusic(0.6)
  }

  static get availableSounds(): readonly string[] {
    return [...Object.keys(SOUND_URLS), ...Object.keys(MUSIC_URLS).map((m) => `music-${m}`)]
  }
}

export const audioManager = new AudioManager()
