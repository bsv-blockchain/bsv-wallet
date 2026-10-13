// The older BSV wallets whose recovery phrases this one can bring in (the
// prototype's components/legacy-wallet-face.tsx and lib/data/legacy-wallets.ts),
// as a row of faces beside "Import wallet": three, overlapping, and "+7",
// stepping along one wallet at a time, each newcomer popping in.
import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Image } from 'expo-image'
import { font, usePalette } from '../theme'
import { enter, useReducedMotion } from '../ui/motion'

const LEGACY_WALLETS: { id: string; name: string; icon?: number }[] = [
  { id: 'centbee', name: 'Centbee', icon: require('../../assets/images/wallets/centbee.png') },
  { id: 'rock', name: 'RockWallet', icon: require('../../assets/images/wallets/rock.png') },
  { id: 'moneybutton', name: 'MoneyButton', icon: require('../../assets/images/wallets/moneybutton.png') },
  { id: 'twetch', name: 'Twetch', icon: require('../../assets/images/wallets/twetch.png') },
  { id: 'electrumsv', name: 'ElectrumSV', icon: require('../../assets/images/wallets/electrumsv.png') },
  { id: 'exodus', name: 'Exodus', icon: require('../../assets/images/wallets/exodus.png') },
  { id: 'relayx', name: 'RelayX', icon: require('../../assets/images/wallets/relayx.png') },
  { id: 'keevo', name: 'Keevo' },
  { id: 'atomic', name: 'Atomic', icon: require('../../assets/images/wallets/atomic.png') },
  { id: 'simplycash', name: 'SimplyCash', icon: require('../../assets/images/wallets/simplycash.png') }
]

/** One wallet's logo in an ink circle; its letter when it has none. */
function LegacyFace({ wallet, size, ring }: { wallet: (typeof LEGACY_WALLETS)[number]; size: number; ring: string }) {
  const palette = usePalette()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.ink,
        boxShadow: `0 0 0 2px ${ring}`
      }}
    >
      {wallet.icon ? (
        <Image source={wallet.icon} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        <Text style={[font(800), { color: palette.inkForeground, fontSize: size * 0.48, lineHeight: size * 0.6 }]}>{wallet.name[0]}</Text>
      )}
    </View>
  )
}

export function LegacyFacepile({ max = 3, size = 20, ring }: { max?: number; size?: number; ring: string }) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [off, setOff] = useState(0)
  useEffect(() => {
    if (still) return
    const t = setInterval(() => setOff(o => (o + 1) % LEGACY_WALLETS.length), 1600)
    return () => clearInterval(t)
  }, [still])
  const n = LEGACY_WALLETS.length
  const shown = Array.from({ length: Math.min(max, n) }, (_, i) => LEGACY_WALLETS[(off + i) % n])
  const rest = n - shown.length
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((w, i) => (
        // keyed by wallet, so each newcomer pops in as the row moves along
        <Animated.View
          key={w.id}
          style={[{ marginLeft: i > 0 ? -6 : 0, zIndex: i }, still ? null : enter({ opacity: 0, scale: 0.75, duration: 500 })]}
        >
          <LegacyFace wallet={w} size={size} ring={ring} />
        </Animated.View>
      ))}
      {rest > 0 && (
        <View
          style={{
            marginLeft: -6,
            zIndex: 10,
            height: size,
            minWidth: size,
            paddingHorizontal: 4,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.secondary,
            boxShadow: `0 0 0 2px ${ring}`
          }}
        >
          <Text style={[font(700), { color: palette.mutedForeground, fontSize: 10, lineHeight: 12, fontVariant: ['tabular-nums'] }]}>+{rest}</Text>
        </View>
      )}
    </View>
  )
}
