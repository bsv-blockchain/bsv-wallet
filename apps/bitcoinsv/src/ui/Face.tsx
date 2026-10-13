// Someone on the other side of a payment: their avatar when known, otherwise
// the core's generative sigil for their key or address (the same face the
// existing app draws), as a circle, as the prototype's avatars are. Each wears
// the prototype's hairline ring: a photo `ring-1 ring-border`
// (contact-avatar.tsx), a sigil `ring-1 ring-foreground/10` (identity-sigil.tsx).
import React from 'react'
import { Image, View } from 'react-native'
import { counterpartyHue, sigilPalette, sigilPointOf, useTheme, type Counterparty } from '@bsv/expo-wallet-toolbox'
import Sigil from '@bsv/expo-wallet-toolbox/ui/components/ui/Sigil'
import { usePalette } from '../theme'

export function Face({ counterparty, avatarUrl, size = 40 }: { counterparty: Counterparty; avatarUrl?: string; size?: number }) {
  const { isDark } = useTheme()
  const app = usePalette()
  if (avatarUrl)
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, boxShadow: `0 0 0 1px ${app.border}` }}>
        <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      </View>
    )
  const palette = sigilPalette(counterpartyHue(counterparty), isDark)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: palette.background,
        boxShadow: `0 0 0 1px ${app.foreground}1a`
      }}
    >
      <Sigil point={sigilPointOf(counterparty)} size={size} foreground={palette.foreground} background={palette.background} detail="default" />
    </View>
  )
}
