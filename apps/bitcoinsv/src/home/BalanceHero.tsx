// Home's balance hero: "Total balance" with the privacy eye, and the total in
// big extra-bold figures. Tapping the figure flips between the display
// currency (Settings) and BSV; showing BSV, the label above gives the same
// total in the display currency. While the wallet opens (or its balance is
// still being read) a pulsing bar holds the figure's place; the figure fades
// in over it.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Eye, EyeOff } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import Animated from 'react-native-reanimated'
import { PressScale } from '../ui/PressScale'
import { SkeletonBar } from '../ui/Skeleton'
import { enter, useReducedMotion } from '../ui/motion'
import { HeroMoney, Money, formatMoney, type Unit } from '../ui/Money'
import { currentDisplayCurrency, useDisplayCurrency } from '../state/displayCurrency'

const currentIsBsv = () => currentDisplayCurrency().code === 'BSV'

/** "£12.50", or "0.0015 BSV": a figure as a screen reader says it */
export const spoken = (amount: number, unit: Unit) =>
  unit === 'bsv' || (unit === 'usd' && currentIsBsv()) ? `${formatMoney(amount, 'bsv')} BSV` : formatMoney(amount, unit)

export function BalanceHero({
  bsv,
  usd,
  privacy,
  loading = false,
  onTogglePrivacy
}: {
  bsv: number
  usd: number
  privacy: boolean
  /** no figure yet: a placeholder in its place */
  loading?: boolean
  onTogglePrivacy: () => void
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  // the figure fades in only after a wait for it, not every time Home mounts
  const [waited, setWaited] = useState(loading)
  if (loading && !waited) setWaited(true)
  const dark = useIsDark()
  const [showAlt, setShowAlt] = useState(false)
  const { currency, dollarsOf } = useDisplayCurrency()
  // The display currency first, its other face BSV. With BitcoinSV as the
  // display currency, BSV comes first and its other face is US dollars (none
  // on testnet, whose coins have no price: then there's nothing to flip to).
  const bsvFirst = currency.code === 'BSV'
  const dollars = bsvFirst ? dollarsOf(Math.round(bsv * 100_000_000)) : null
  const primary: Unit = bsvFirst ? 'bsv' : 'usd'
  const other: Unit | null = bsvFirst ? (dollars != null ? 'dollars' : null) : 'bsv'
  const shown: Unit = showAlt && other ? other : primary
  const amountIn = (u: Unit) => (u === 'bsv' ? bsv : u === 'dollars' ? (dollars ?? 0) : usd)
  // BSV up big: the label above gives the same total in money you know
  const labelUnit: Unit | null = shown === 'bsv' ? (bsvFirst ? other : 'usd') : null
  const EyeIcon = privacy ? EyeOff : Eye
  // .hero-glow (a single text shadow is all React Native draws)
  const glow = dark
    ? { textShadowColor: 'rgba(4,7,13,0.85)', textShadowRadius: 18 }
    : { textShadowColor: 'rgba(255,255,255,0.9)', textShadowRadius: 18 }
  return (
    <View style={styles.hero}>
      <Pressable onPress={onTogglePrivacy} accessibilityRole="button" accessibilityLabel={privacy ? 'Show balances' : 'Hide balances'} style={styles.label}>
        {labelUnit ? (
          <Money amount={amountIn(labelUnit)} unit={labelUnit} privacy={privacy} style={[font(600), styles.labelFiat, { color: palette.mutedForeground }, glow]} />
        ) : (
          <Text style={[font(600), styles.labelText, { color: palette.mutedForeground }, glow]}>TOTAL BALANCE</Text>
        )}
        <EyeIcon size={14} color={palette.mutedForeground} />
      </Pressable>
      {loading ? (
        <SkeletonBar style={styles.placeholder} />
      ) : (
      <Animated.View style={waited && !still ? enter({ duration: 300 }) : null}>
      {/* rounded-xl transition-transform active:scale-[0.98] */}
      <PressScale
        onPress={() => other && setShowAlt(v => !v)}
        accessibilityRole="button"
        accessibilityLabel={`Total balance, ${privacy ? 'hidden' : spoken(amountIn(shown), shown)}`}
        accessibilityHint={other ? `Shows it in ${shown === primary ? (other === 'bsv' ? 'BSV' : 'US dollars') : bsvFirst ? 'BSV' : currency.code}` : undefined}
        scale={0.98}
        style={{ borderRadius: radii.xl }}
      >
        <HeroMoney
          amount={amountIn(shown)}
          unit={shown}
          privacy={privacy}
          style={{ ...font(800), ...styles.figure, color: palette.foreground, ...glow }}
        />
      </PressScale>
      </Animated.View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 4, paddingTop: 4 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  labelText: { fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },
  labelFiat: { fontSize: 13, lineHeight: 16 },
  // the figure's line, as wide as a typical balance
  placeholder: { width: 168, height: 40, marginVertical: 4, borderRadius: radii.xl },
  figure: { fontSize: 48, lineHeight: 48, letterSpacing: -1.2, fontVariant: ['tabular-nums', 'lining-nums'] }
})
