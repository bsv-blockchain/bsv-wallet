/**
 * The "what can I actually send?" line under the amount input.
 *
 * One footnote: the spendable figure, then "available". By default, the figure
 * is in the unit the input above it is taking (satoshis or EUR) with no symbol
 * or unit word, because the input's own suffix already names it. Renders nothing
 * until a figure exists rather than flashing "0", and nothing in fiat mode until
 * a rate exists rather than inventing one.
 *
 * When `withUnit` is true, render as a unit-labelled figure via AmountDisplay
 * instead — used standalone under a unit-labelled headline (e.g. a confirm
 * screen showing "$12.34" above) where no input suffix names the unit.
 */
import React, { useContext } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useSpendableBalance } from '../../hooks/useSpendableBalance'
import {
  ExchangeRateContext,
  formatAmountInInputUnit,
  spacing,
  typography,
  useTheme,
  useWallet
} from '@bsv/expo-wallet-toolbox'
import AmountDisplay from '../wallet/AmountDisplay'

export default function AvailableBalance({ withUnit = false }: { withUnit?: boolean }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const balance = useSpendableBalance()

  if (balance == null) return null

  if (withUnit) {
    return (
      <Text style={[styles.text, { color: colors.textSecondary }]} accessibilityRole="text">
        <Text style={[styles.figure, { color: colors.textPrimary }]}>
          <AmountDisplay>{balance}</AmountDisplay>
        </Text>{' '}
        {t('available')}
      </Text>
    )
  }

  const figure = formatAmountInInputUnit(balance, settings?.currency || 'BSV', satoshisPerUSD, usdToFiat)
  if (!figure) return null

  return (
    <Text style={[styles.text, { color: colors.textSecondary }]} accessibilityRole="text">
      <Text style={[styles.figure, { color: colors.textPrimary }]}>{figure}</Text> {t('available')}
    </Text>
  )
}

const styles = StyleSheet.create({
  text: { ...typography.footnote, marginTop: spacing.sm },
  figure: { ...typography.footnote, fontWeight: '600', fontVariant: ['tabular-nums'] }
})
