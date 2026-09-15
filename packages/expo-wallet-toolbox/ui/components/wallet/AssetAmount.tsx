/**
 * A token money figure — the sibling of `AmountDisplay`, and deliberately not a
 * mode of it.
 *
 * `AmountDisplay` is a satoshi component: it reads `settings.currency`, asks
 * the exchange-rate context for a cross, and formats with the BSV thresholds.
 * None of that is true of a token, and every one of those behaviours would be a
 * lie if it fired here — there is no price for a stablecoin in this wallet and
 * a ticker is not a currency code (ux §6.1).
 *
 * Three states, and only one of them prints a number:
 *  · a figure, in the asset's own fixed decimals;
 *  · a spinner while the balance is UNKNOWN (`null`), because "0 USDX" is a
 *    claim about someone's money and a cold read is not entitled to make it;
 *  · nothing at all when the figure cannot be formatted, rather than `NaN`.
 *
 * VoiceOver reads one composed label ("1,240.00 USDX"), never two fragments:
 * the value and its unit are separate `<Text>`s only so the unit can be
 * demoted visually.
 */
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import { formatTokenAmountWithUnit, tokenAmountParts } from '../../tokenFormat'

export interface AssetAmountProps {
  /** Base units. `null` means UNKNOWN and renders a spinner, never a zero. */
  baseUnits: number | null
  asset: { decimals: number; ticker: string }
  /** `row` is the balances/activity figure; `sheet` is the Asset sheet's headline. */
  size?: 'row' | 'sheet'
  showPlus?: boolean
  /** `incoming` is the one place green appears on a figure: money that arrived. */
  tone?: 'primary' | 'incoming' | 'secondary'
}

export default function AssetAmount({
  baseUnits,
  asset,
  size = 'row',
  showPlus = false,
  tone = 'primary'
}: AssetAmountProps) {
  const { colors } = useTheme()

  if (baseUnits === null) {
    return <ActivityIndicator size="small" color={colors.textTertiary} accessibilityRole="progressbar" />
  }

  const parts = tokenAmountParts(baseUnits, asset, { showPlus })
  if (!parts) return null
  const label = formatTokenAmountWithUnit(baseUnits, asset, { showPlus }) ?? ''

  const color =
    tone === 'incoming' ? colors.successAmount : tone === 'secondary' ? colors.textSecondary : colors.textPrimary

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      // The figure and the ticker are one money fact. Read apart they become
      // "one thousand two hundred forty point zero zero" … "U S D X", with a
      // pause in the middle that invites the listener to act on the first half.
      importantForAccessibility="yes"
    >
      <Text
        style={[size === 'sheet' ? styles.sheetValue : styles.rowValue, { color }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={1.3}
        importantForAccessibility="no-hide-descendants"
      >
        {parts.value}
      </Text>
      <Text
        style={[size === 'sheet' ? styles.sheetUnit : styles.rowUnit, { color: colors.textSecondary }]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        importantForAccessibility="no-hide-descendants"
      >
        {parts.unit}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, flexShrink: 1 },
  rowValue: { ...typography.title3, fontVariant: ['tabular-nums'] },
  rowUnit: { ...typography.footnote },
  sheetValue: { ...typography.title1, fontVariant: ['tabular-nums'] },
  sheetUnit: { ...typography.subhead }
})
