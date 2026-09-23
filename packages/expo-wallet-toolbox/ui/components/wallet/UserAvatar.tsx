/**
 * The user's own face, wherever "you" is drawn.
 *
 * One component so the home button and the profile hero can never disagree
 * about what the user picked. With no choice stored it falls back to the
 * plain person glyph those surfaces have always shown, so an install that
 * never opens the picker looks exactly as it did.
 */
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme, useUserAvatarIcon, type AvatarIconFamily } from '@bsv/expo-wallet-toolbox'

type VectorIcons = typeof import('@expo/vector-icons')
let vectorIcons: VectorIcons | undefined
function loadIcons(): VectorIcons {
  if (!vectorIcons) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vectorIcons = require('@expo/vector-icons') as VectorIcons
  }
  return vectorIcons
}

/** Draw one catalogue entry, whichever family it came from. */
export function AvatarGlyph({
  family,
  name,
  size,
  color
}: {
  family: AvatarIconFamily
  name: string
  size: number
  color: string
}) {
  const { Ionicons, MaterialCommunityIcons } = loadIcons()
  const Icon = family === 'ionicons' ? Ionicons : MaterialCommunityIcons
  return <Icon name={name as never} size={size} color={color} />
}

export default function UserAvatar({
  size = 34,
  /** Glyph size; defaults to roughly half the disc, as the 34pt button does. */
  glyphSize,
  color,
  background,
  borderColor,
  style
}: {
  size?: number
  glyphSize?: number
  color?: string
  background?: string
  borderColor?: string
  style?: object
}) {
  const { colors } = useTheme()
  const chosen = useUserAvatarIcon()
  const glyph = glyphSize ?? Math.round(size * 0.5)
  return (
    <View
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background ?? colors.surfaceRaised,
          borderColor: borderColor ?? colors.surfaceRaisedBorder
        },
        style
      ]}
    >
      <AvatarGlyph
        family={chosen?.family ?? 'ionicons'}
        name={chosen?.name ?? 'person-outline'}
        size={glyph}
        color={color ?? colors.textSecondary}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }
})
