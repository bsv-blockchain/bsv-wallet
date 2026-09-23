/**
 * The icons offered as an avatar, grouped the way the picker shows them.
 *
 * Only families this app already ships (see `@expo/vector-icons`): Ionicons
 * for people, nature and objects, MaterialCommunityIcons for the animals,
 * which Ionicons has almost none of. Nothing here adds a dependency.
 *
 * Chosen for being something a person would actually WEAR — creatures and
 * characters, not UI furniture. Every name below was checked against the
 * shipped glyph maps; a name that is not in them renders as a blank square,
 * which is why this list is explicit rather than generated from a prefix.
 */
import type { AvatarIconFamily } from '@bsv/expo-wallet-toolbox'

export interface AvatarIconOption {
  family: AvatarIconFamily
  name: string
}

export interface AvatarIconGroup {
  /** i18n key for the section heading, with an English fallback. */
  labelKey: string
  labelFallback: string
  icons: AvatarIconOption[]
}

const mc = (name: string): AvatarIconOption => ({ family: 'material-community', name })
const io = (name: string): AvatarIconOption => ({ family: 'ionicons', name })

export const AVATAR_ICON_GROUPS: AvatarIconGroup[] = [
  {
    labelKey: 'avatar_group_animals',
    labelFallback: 'Animals',
    icons: [
      mc('cat'),
      mc('dog'),
      mc('rabbit'),
      mc('owl'),
      mc('panda'),
      mc('koala'),
      mc('penguin'),
      mc('bird'),
      mc('duck'),
      mc('horse'),
      mc('elephant'),
      mc('kangaroo'),
      mc('cow'),
      mc('pig'),
      mc('sheep'),
      mc('turtle'),
      mc('tortoise'),
      mc('snake'),
      mc('dolphin'),
      mc('shark'),
      mc('fish'),
      mc('jellyfish'),
      mc('butterfly'),
      mc('bee'),
      mc('ladybug'),
      mc('snail'),
      mc('spider'),
      mc('bat'),
      mc('unicorn')
    ]
  },
  {
    labelKey: 'avatar_group_characters',
    labelFallback: 'Characters',
    icons: [
      mc('emoticon-happy-outline'),
      mc('emoticon-cool-outline'),
      mc('robot'),
      mc('alien'),
      mc('ghost'),
      mc('account'),
      mc('human'),
      mc('sunglasses'),
      io('happy-outline'),
      io('person-outline'),
      io('people-outline'),
      io('skull-outline')
    ]
  },
  {
    labelKey: 'avatar_group_nature',
    labelFallback: 'Nature',
    icons: [
      io('leaf-outline'),
      io('flower-outline'),
      io('paw-outline'),
      io('planet-outline'),
      io('moon-outline'),
      io('sunny-outline'),
      io('snow-outline'),
      io('flame-outline'),
      io('star-outline'),
      io('heart-outline'),
      io('diamond-outline'),
      io('flash-outline')
    ]
  },
  {
    labelKey: 'avatar_group_things',
    labelFallback: 'Things',
    icons: [
      io('rocket-outline'),
      io('game-controller-outline'),
      io('musical-note-outline'),
      io('headset-outline'),
      io('camera-outline'),
      io('bicycle-outline'),
      io('football-outline'),
      io('basketball-outline'),
      io('pizza-outline'),
      io('ice-cream-outline'),
      io('cafe-outline'),
      io('balloon-outline'),
      io('gift-outline'),
      io('glasses-outline')
    ]
  }
]
