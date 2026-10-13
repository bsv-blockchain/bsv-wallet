// The prototype's ContactAvatar for portraits (components/contact-avatar.tsx,
// lib/data/avatars.ts): a pixel-art animal standing on the bottom edge of a
// soft colour disc. A new wallet starts as the dragon.
import React from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Image } from 'expo-image'
import { usePalette } from '../theme'

/** oklch(0.87 0.08 <hue>), converted. */
export const AVATAR_BACKGROUNDS = {
  rose: '#ffbfc8',
  peach: '#fcc89f',
  butter: '#e0d699',
  mint: '#a6e5c2',
  sky: '#a0ddff',
  lavender: '#dcc9ff'
} as const
export type AvatarBg = keyof typeof AVATAR_BACKGROUNDS

const PORTRAITS = {
  dragon: require('../../assets/avatars/dragon.png'),
  phoenix: require('../../assets/avatars/phoenix.png'),
  whale: require('../../assets/avatars/whale.png'),
  swan: require('../../assets/avatars/swan.png'),
  frog: require('../../assets/avatars/frog.png'),
  unicorn: require('../../assets/avatars/unicorn.png'),
  gorilla: require('../../assets/avatars/gorilla.png'),
  beaver: require('../../assets/avatars/beaver.png'),
  bull: require('../../assets/avatars/bull.png')
} as const
export type Portrait = keyof typeof PORTRAITS

export const randomAvatarBg = (): AvatarBg => {
  const keys = Object.keys(AVATAR_BACKGROUNDS) as AvatarBg[]
  return keys[Math.floor(Math.random() * keys.length)]
}

export const PORTRAIT_NAMES = Object.keys(PORTRAITS) as Portrait[]

export function Avatar({ portrait = 'dragon', bg, uri, size }: { portrait?: Portrait; bg: AvatarBg; uri?: string | null; size: number }) {
  const palette = usePalette()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'flex-end',
        backgroundColor: AVATAR_BACKGROUNDS[bg],
        boxShadow: `0 0 0 1px ${palette.border}`
      }}
    >
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        // portraits: the animal at 86%, standing on the bottom edge
        <Image source={PORTRAITS[portrait]} style={{ width: '86%', height: '86%' }} contentFit="contain" contentPosition="bottom" />
      )}
    </View>
  )
}

/**
 * A new face every moment (the prototype's CyclingAvatar, beside "Create new
 * wallet"): the animal and the colour take turns to change, each fading into
 * the next.
 */
export function CyclingAvatar({ size = 22 }: { size?: number }) {
  const palette = usePalette()
  const [s, setS] = React.useState({ k: 0, a: 0, b: 0 })
  React.useEffect(() => {
    const t = setInterval(
      () => setS(({ k, a, b }) => (k % 2 === 0 ? { k: k + 1, a: a + 1, b } : { k: k + 1, a, b: b + 1 + (k % 36 === 35 ? 1 : 0) })),
      1400
    )
    return () => clearInterval(t)
  }, [])
  const bgs = Object.values(AVATAR_BACKGROUNDS)
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'flex-end',
        backgroundColor: bgs[s.b % bgs.length],
        boxShadow: `0 0 0 1px ${palette.border}`,
        transitionProperty: 'backgroundColor',
        transitionDuration: 1000
      }}
    >
      <Image source={PORTRAITS[PORTRAIT_NAMES[s.a % PORTRAIT_NAMES.length]]} transition={1000} style={{ width: '86%', height: '86%' }} contentFit="contain" contentPosition="bottom" />
    </Animated.View>
  )
}
