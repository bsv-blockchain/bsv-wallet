// The prototype's CurrencyPicker, variant "icon" (components/currency-
// picker.tsx): the coin's own mark, with a small ink chevron badge so it
// reads as tappable; it opens the currency chooser. The badge grows with the
// mark (16px at 40, ~19px at 64), and the press eases to active:scale-[0.96].
import React from 'react'
import { View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { usePalette } from '../theme'
import { CoinMark, type Coin } from '../ui/CoinMark'
import { PressScale } from '../ui/PressScale'

export function CoinButton({
  coin,
  size,
  onPress,
  badge = true,
  accessibilityLabel
}: {
  coin: Coin
  size: number
  onPress: () => void
  /** the chevron (off when there's nothing else to choose) */
  badge?: boolean
  accessibilityLabel: string
}) {
  const palette = usePalette()
  const b = Math.max(16, Math.round(size * 0.3))
  return (
    <PressScale scale={0.96} onPress={onPress} disabled={!badge} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={{ width: size, height: size }}>
      <CoinMark coin={coin} size={size} />
      {badge && (
        <View
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: b,
            height: b,
            borderRadius: b / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.ink,
            boxShadow: `0 0 0 2px ${palette.background}`
          }}
        >
          <ChevronDown size={b * 0.75} color={palette.inkForeground} strokeWidth={2.5} />
        </View>
      )}
    </PressScale>
  )
}
