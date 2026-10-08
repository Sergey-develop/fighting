import { beforeEach, describe, expect, it } from 'vitest'
import { controlsRecord, settingsRecord, statisticsRecord } from '../src/game/storage/records'
import { load, save, type StoredRecord } from '../src/game/storage/storage'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(k: string): string | null {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v)
  }
  removeItem(k: string): void {
    this.data.delete(k)
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new MemoryStorage() }, configurable: true })
})

describe('storage', () => {
  it('round-trips settings and statistics', () => {
    const s = load(settingsRecord)
    s.roundTimeSeconds = 99
    s.audio.music = 0.2
    save(settingsRecord, s)
    expect(load(settingsRecord).roundTimeSeconds).toBe(99)
    const st = load(statisticsRecord)
    st.vsAi.wins = 3
    st.fighters['developer'] = { wins: 2, losses: 1 }
    save(statisticsRecord, st)
    expect(load(statisticsRecord).vsAi.wins).toBe(3)
    expect(load(statisticsRecord).fighters['developer']?.wins).toBe(2)
  })

  it('falls back to defaults on corrupt or future data', () => {
    window.localStorage.setItem('fighting.settings', '{not json')
    expect(load(settingsRecord).roundTimeSeconds).toBe(60)
    window.localStorage.setItem('fighting.settings', JSON.stringify({ version: 999, data: {} }))
    expect(load(settingsRecord).roundTimeSeconds).toBe(60)
  })

  it('sanitises invalid fields and keeps valid bindings', () => {
    window.localStorage.setItem(
      'fighting.controls',
      JSON.stringify({
        version: 1,
        data: {
          players: [{ device: { kind: 'gamepad', index: 1, id: 'pad' }, keyboard: { light: ['KeyZ', 42] } }, null],
          deadzone: 5,
        },
      }),
    )
    const c = load(controlsRecord)
    expect(c.players[0].device).toEqual({ kind: 'gamepad', index: 1, id: 'pad' })
    expect(c.players[0].keyboard.light).toEqual(['KeyZ'])
    expect(c.players[0].keyboard.heavy).toEqual(['KeyK'])
    expect(c.players[1].keyboard.left).toEqual(['ArrowLeft'])
    expect(c.deadzone).toBe(0.9)
  })

  it('runs migrations for older versions', () => {
    const rec: StoredRecord<{ name: string }> = {
      key: 'migrated',
      version: 2,
      defaults: () => ({ name: 'default' }),
      validate: (d) => (typeof d === 'object' && d !== null && 'name' in d && typeof d.name === 'string' ? { name: d.name } : null),
      migrations: { 1: (d) => ({ name: String((d as { title?: unknown }).title) }) },
    }
    window.localStorage.setItem('fighting.migrated', JSON.stringify({ version: 1, data: { title: 'old' } }))
    expect(load(rec).name).toBe('old')
  })
})
