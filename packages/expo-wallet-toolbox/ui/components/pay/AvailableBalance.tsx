/**
 * The "what can I actually send?" line every send surface opens with.
 *
 * One compact row — wallet glyph, the spendable figure, "available" — kept to
 * footnote weight so the form below stays the focal point (the wallet screen
 * owns the 44pt balance; here it is context, not headline). The figure runs
 * through AmountDisplay so it follows the user's BSV/fiat currency setting,
 * and the row renders nothing until a figure exists rather than flashing "0".
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useSpendableBalance } from '../../hooks/useSpendableBalance'
import { useTheme, spacing, typography } from '@bsv/expo-wallet-toolbox'
import AmountDisplay from '../wallet/AmountDisplay'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

export default function AvailableBalance() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const balance = useSpendableBalance()
  const Ionicons = loadIonicons()

  if (balance == null) return null

  return (
    <View style={styles.row} accessibilityRole="text">
      <Ionicons name="wallet-outline" size={14} color={colors.textSecondary} />
      <Text style={[styles.text, { color: colors.textSecondary }]}>
        <Text style={[styles.figure, { color: colors.textPrimary }]}>
          <AmountDisplay>{balance}</AmountDisplay>
        </Text>{' '}
        {t('available')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.lg
  },
  text: { ...typography.footnote },
  figure: { ...typography.footnote, fontWeight: '600', fontVariant: ['tabular-nums'] }
})
