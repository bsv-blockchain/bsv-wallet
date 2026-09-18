/**
 * A counterparty's face: their avatar when one is known, otherwise always
 * their generative sigil — never an initials placeholder (2026-09-18 design
 * ruling). Shared by Contacts, Contact, New Contact and Pay's recipient card,
 * so all four draw the same face for the same identity key.
 */
import React from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { useTheme, counterpartyHue, sigilPointOf, sigilPalette, type Counterparty } from '@bsv/expo-wallet-toolbox'
import Sigil from '../ui/Sigil'

export default function ContactSigil({
  identityKey,
  avatarUrl,
  size = 38,
  radius = 12
}: {
  identityKey: string
  avatarUrl?: string
  size?: number
  radius?: number
}) {
  const { isDark } = useTheme()
  if (avatarUrl) {
    return (
      <Image source={{ uri: avatarUrl }} style={[styles.tile, { width: size, height: size, borderRadius: radius }]} />
    )
  }
  const cp: Counterparty = { kind: 'identityKey', value: identityKey }
  const point = sigilPointOf(cp)
  const palette = sigilPalette(counterpartyHue(cp), isDark)
  return (
    <View
      style={[styles.tile, { width: size, height: size, borderRadius: radius, backgroundColor: palette.background }]}
    >
      <Sigil
        point={point}
        size={size}
        foreground={palette.foreground}
        background={palette.background}
        detail="default"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
})
