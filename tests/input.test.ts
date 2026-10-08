import { beforeEach, describe, expect, it } from 'vitest'
import { ACTION_BIT, MENU_BIT, createInputFrame } from '../src/game/input/actions'
import { PAD } from '../src/game/input/bindings'
import { InputManager } from '../src/game/input/input-manager'

interface FakePad {
  id: string
  connected: boolean
  mapping: string
  buttons: { pressed: boolean; value: number }[]
  axes: number[]
}

const pads: (FakePad | null)[] = [null, null, null, null]

function makePad(id: string): FakePad {
  return {
    id,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  }
}

function press(pad: FakePad, button: number, down = true): void {
  const b = pad.buttons[button]
  if (b) {
    b.pressed = down
    b.value = down ? 1 : 0
  }
}

beforeEach(() => {
  pads.fill(null)
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
  })
})

describe('InputManager gamepads', () => {
  it('menu: A confirms, D-pad navigates, edges are consumed once', () => {
    const im = new InputManager()
    const pad = makePad('Xbox Controller')
    pads[0] = pad
    im.poll()
    press(pad, PAD.A)
    press(pad, PAD.RIGHT)
    im.poll()
    const m = im.readMenuAny()
    expect(m & MENU_BIT.confirm).toBeTruthy()
    expect(m & MENU_BIT.right).toBeTruthy()
    expect(im.padWithAnyPress()).toBe(0)
    im.endTick()
    im.poll() // still held → no new edge
    expect(im.readMenuAny()).toBe(0)
  })

  it('per-seat menu input follows the assigned device', () => {
    const im = new InputManager()
    const a = makePad('pad A')
    const b = makePad('pad B')
    pads[0] = a
    pads[1] = b
    im.controls.players[0].device = { kind: 'gamepad', index: 1, id: 'pad B' }
    im.controls.players[1].device = { kind: 'gamepad', index: 0, id: 'pad A' }
    im.poll()
    press(b, PAD.A)
    im.poll()
    expect(im.readMenu(0) & MENU_BIT.confirm).toBeTruthy()
    expect(im.readMenu(1)).toBe(0)
  })

  it('fight input: X = light, LB held = block, stick = movement', () => {
    const im = new InputManager()
    const pad = makePad('pad')
    pads[0] = pad
    im.controls.players[0].device = { kind: 'gamepad', index: 0, id: null }
    im.poll()
    press(pad, PAD.X)
    press(pad, PAD.LB)
    pad.axes[0] = -0.9
    im.poll()
    const f = createInputFrame()
    im.readPlayer(0, f)
    expect(f.pressed & ACTION_BIT.light).toBeTruthy()
    expect(f.held & ACTION_BIT.block).toBeTruthy()
    expect(f.held & ACTION_BIT.left).toBeTruthy()
  })

  it('finds a reconnected pad by id even if its index changed', () => {
    const im = new InputManager()
    pads[2] = makePad('my pad')
    im.poll()
    expect(im.resolvePad({ index: 0, id: 'my pad' })).toBe(2)
  })

  it('vs AI: keyboard and gamepad drive player 1 at the same time', () => {
    const im = new InputManager()
    const pad = makePad('pad')
    pads[0] = pad
    im.controls.players[0].device = { kind: 'keyboard' }
    im.poll()
    press(pad, PAD.X)
    im.poll()
    const f = createInputFrame()
    im.readPlayerAnyDevice(0, f)
    expect(f.pressed & ACTION_BIT.light).toBeTruthy()
  })

  it('two seats never share one gamepad', () => {
    const im = new InputManager()
    pads[0] = makePad('pad')
    im.poll()
    im.controls.players[0].device = { kind: 'gamepad', index: 0, id: 'pad' }
    im.controls.players[1].device = { kind: 'gamepad', index: 0, id: null }
    expect(im.ensureDistinctDevices()).toBe(true)
    expect(im.controls.players[0].device.kind).toBe('gamepad')
    expect(im.controls.players[1].device.kind).toBe('keyboard')
    expect(im.ensureDistinctDevices()).toBe(false)
  })

  it('inputs already held when a pad appears are ignored until released', () => {
    const im = new InputManager()
    const pad = makePad('pad')
    press(pad, PAD.LB) // e.g. a stuck trigger / phantom device
    pads[0] = pad
    im.controls.players[0].device = { kind: 'gamepad', index: 0, id: null }
    im.poll()
    im.poll()
    const f = createInputFrame()
    im.readPlayer(0, f)
    expect(f.held & ACTION_BIT.block).toBe(0)
    press(pad, PAD.LB, false)
    im.poll()
    press(pad, PAD.LB)
    im.poll()
    im.readPlayer(0, f)
    expect(f.held & ACTION_BIT.block).toBeTruthy()
  })

  it('vs AI: a non-standard duplicate with a stuck block does not freeze walking', () => {
    const im = new InputManager()
    const real = makePad('Xbox 360 Controller (XInput STANDARD GAMEPAD)')
    const dup = makePad('Wireless Controller (raw)')
    dup.mapping = ''
    pads[0] = dup
    pads[1] = real
    im.poll()
    press(dup, PAD.LB) // raw duplicate reports a different layout
    real.axes[0] = 0.9 // stick right on the real pad
    im.poll()
    const f = createInputFrame()
    im.readPlayerAnyDevice(0, f)
    expect(f.held & ACTION_BIT.right).toBeTruthy()
    expect(f.held & ACTION_BIT.block).toBe(0)
  })

  it('keyboard vs controller: the controller seat listens to every pad', () => {
    const im = new InputManager()
    const pad = makePad('pad')
    pads[2] = pad // the real controller sits at an unexpected index
    im.controls.players[0].device = { kind: 'gamepad', index: 0, id: null }
    im.controls.players[1].device = { kind: 'keyboard' }
    im.poll()
    pad.axes[0] = -0.9
    im.poll()
    expect(im.isSeatConnected(0)).toBe(true)
    const f = createInputFrame()
    im.readPlayer(0, f)
    expect(f.held & ACTION_BIT.left).toBeTruthy()
  })
})
