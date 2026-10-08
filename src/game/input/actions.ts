/**
 * Logical game actions. Devices are mapped onto these; the fighter
 * controller and combat code only ever see InputAction bit masks.
 */
export const INPUT_ACTIONS = [
  'left',
  'right',
  'down',
  'jump',
  'light',
  'heavy',
  'kick',
  'special',
  'block',
  'pause',
] as const

export type InputAction = (typeof INPUT_ACTIONS)[number]

/** Actions the player can rebind on the Controls screen. */
export const REBINDABLE_ACTIONS: readonly InputAction[] = [
  'left',
  'right',
  'jump',
  'down',
  'light',
  'heavy',
  'kick',
  'special',
  'block',
]

export const ACTION_BIT: Readonly<Record<InputAction, number>> = {
  left: 1 << 0,
  right: 1 << 1,
  down: 1 << 2,
  jump: 1 << 3,
  light: 1 << 4,
  heavy: 1 << 5,
  kick: 1 << 6,
  special: 1 << 7,
  block: 1 << 8,
  pause: 1 << 9,
}

export const ACTION_LABEL: Readonly<Record<InputAction, string>> = {
  left: 'Влево',
  right: 'Вправо',
  down: 'Вниз (меню)',
  jump: 'Прыжок',
  light: 'Слабый удар',
  heavy: 'Сильный удар',
  kick: 'Удар ногой',
  special: 'Спецприём',
  block: 'Блок',
  pause: 'Пауза',
}

/** One simulation tick of input for one player. Reused, never reallocated. */
export interface InputFrame {
  /** actions currently held */
  held: number
  /** actions that went down since the previous tick */
  pressed: number
}

export function createInputFrame(): InputFrame {
  return { held: 0, pressed: 0 }
}

export function has(mask: number, action: InputAction): boolean {
  return (mask & ACTION_BIT[action]) !== 0
}

/** Menu navigation, derived from device input. */
export const MENU_ACTIONS = ['up', 'down', 'left', 'right', 'confirm', 'back'] as const
export type MenuAction = (typeof MENU_ACTIONS)[number]

export const MENU_BIT: Readonly<Record<MenuAction, number>> = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  confirm: 1 << 4,
  back: 1 << 5,
}

export function hasMenu(mask: number, action: MenuAction): boolean {
  return (mask & MENU_BIT[action]) !== 0
}
