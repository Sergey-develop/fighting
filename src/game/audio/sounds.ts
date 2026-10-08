/** Every sound the game can request. Files are optional (see AudioManager). */
export const SOUND_IDS = [
  'ui-move',
  'ui-confirm',
  'ui-back',
  'jump',
  'land',
  'whiff-light',
  'whiff-heavy',
  'whiff-kick',
  'special-charge',
  'hit-light',
  'hit-heavy',
  'hit-special',
  'block',
  'guard-break',
  'ko',
  'round',
  'fight',
] as const

export type SoundId = (typeof SOUND_IDS)[number]

/** menu = main menu & screens, vs = pre-fight sting (plays once), fight = combat loop */
export const MUSIC_IDS = ['menu', 'vs', 'fight'] as const
export type MusicId = (typeof MUSIC_IDS)[number]
