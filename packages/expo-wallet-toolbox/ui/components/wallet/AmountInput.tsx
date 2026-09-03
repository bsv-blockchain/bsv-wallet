import React, { useContext, useState, useEffect, useRef } from 'react'
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native'
import Animated, { FadeInUp, FadeOutDown, useReducedMotion } from 'react-native-reanimated'
import { useTranslation } from 'react-i18next'
import {
  useTheme,
  spacing,
  typography,
  radii,
  durations,
  useWallet,
  ExchangeRateContext,
  parseDisplayToSatoshis,
  formatAmount,
  isFiatCurrency,
  fiatFractionDigits,
  satoshisPerFiatUnit
} from '@bsv/expo-wallet-toolbox'

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

export const SEND_MAX_VALUE = '2099999999999999'

interface AmountInputProps {
  /**
   * Show the "Send Max" shortcut. Defaults to true for send flows.
   * Pass false when asking someone ELSE to pay: the max there would be the
   * requester's own balance, which is meaningless to the payer.
   */
  showMax?: boolean
  /**
   * i18n key for the label shown once max is chosen. Defaults to the wallet
   * wording; the vault passes its own, since "entire wallet balance" would be
   * plainly wrong on a screen moving only the vault basket.
   */
  maxLabelKey?: string
  value: string
  onChangeText: (text: string) => void
}

/**
 * Unit-aware amount input component.
 *
 * In BSV mode (default): accepts integer satoshis via number-pad.
 * In fiat mode: accepts a decimal amount in the selected currency (0 decimals
 * for JPY, 2 for EUR, etc.) via decimal-pad, converts to satoshis internally.
 *
 * The `onChangeText` callback always emits satoshi integer strings.
 * The `value` prop is always satoshi integer strings.
 */
export const AmountInput: React.FC<AmountInputProps> = ({
  value,
  onChangeText,
  showMax = true,
  maxLabelKey = 'entire_wallet_balance'
}) => {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const reducedMotion = useReducedMotion()
  const Ionicons = loadIonicons()

  const currency = settings?.currency || 'BSV'
  const isFiat = isFiatCurrency(currency)
  const fractionDigits = isFiat ? fiatFractionDigits(currency) : 0
  const isSendMax = value === SEND_MAX_VALUE

  // In fiat mode, we maintain a separate display value from the satoshi value
  const [fiatDisplayValue, setFiatDisplayValue] = useState('')
  const lastEmittedSats = useRef('')

  // Sync fiat display value when the satoshi value changes externally (e.g., cleared by parent)
  useEffect(() => {
    if (!isFiat) return
    // Avoid re-syncing when we caused the change ourselves
    if (value === lastEmittedSats.current) return

    if (!value || value === '0') {
      setFiatDisplayValue('')
    } else if (value === SEND_MAX_VALUE) {
      // Don't try to convert SEND_MAX_VALUE to fiat
    } else {
      const sats = parseInt(value, 10)
      const per = satoshisPerFiatUnit(currency, satoshisPerUSD, usdToFiat)
      if (!isNaN(sats) && per > 0) {
        const amount = sats / per
        if (fractionDigits === 0) {
          setFiatDisplayValue(String(Math.round(amount)))
        } else {
          setFiatDisplayValue(
            amount % 1 === 0
              ? amount.toFixed(0)
              : amount.toFixed(fractionDigits).replace(/0+$/, '').replace(/\.$/, '')
          )
        }
      }
    }
    lastEmittedSats.current = value
  }, [value, isFiat, currency, satoshisPerUSD, usdToFiat, fractionDigits])

  const handleChangeText = (text: string) => {
    if (isFiat) {
      const allowed = fractionDigits === 0 ? /^\d*$/ : new RegExp(`^\\d*\\.?\\d{0,${fractionDigits}}$`)
      if (text && !allowed.test(text)) return
      setFiatDisplayValue(text)
      const sats = parseDisplayToSatoshis(text, currency, satoshisPerUSD, usdToFiat)
      const satsStr = text ? String(sats) : ''
      lastEmittedSats.current = satsStr
      onChangeText(satsStr)
    } else {
      onChangeText(text)
    }
  }

  if (isSendMax) {
    return (
      <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.accent }]}>
        <View style={styles.sendMaxDisplay}>
          <Ionicons name="wallet-outline" size={18} color={colors.accent} />
          <Text style={[styles.sendMaxLabel, { color: colors.accent }]}>{t(maxLabelKey)}</Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            if (isFiat) setFiatDisplayValue('')
            onChangeText('')
          }}
          style={[styles.clearButton, { backgroundColor: colors.fill }]}
        >
          <Ionicons name="close" size={16} color={colors.accent} />
        </TouchableOpacity>
      </View>
    )
  }

  const displayValue = isFiat ? fiatDisplayValue : value
  const placeholder = isFiat ? (fractionDigits === 0 ? '0' : '0.00') : '0'
  const keyboardType = isFiat && fractionDigits > 0 ? ('decimal-pad' as const) : ('number-pad' as const)
  const unitLabel = isFiat ? currency : 'satoshis'

  // Secondary converted-currency line: BSV when showing fiat, USD when showing BSV
  const satsForConversion = value ? parseInt(value, 10) : 0
  const secondaryText = isFiat
    ? (satsForConversion > 0 ? formatAmount(satsForConversion, 'BSV', satoshisPerUSD) : null)
    : (satsForConversion > 0 && satoshisPerUSD > 0 ? formatAmount(satsForConversion, 'USD', satoshisPerUSD) : null)

  const entering = reducedMotion ? undefined : FadeInUp.duration(durations.instant)
  const exiting = reducedMotion ? undefined : FadeOutDown.duration(durations.instant)

  return (
    <View>
      <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
        <TextInput
          value={displayValue}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          keyboardType={keyboardType}
          returnKeyType="done"
          style={[styles.input, { color: colors.textPrimary }]}
        />
        <View style={styles.unitLabelPressable}>
          <Animated.View key={unitLabel} entering={entering} exiting={exiting}>
            <Text style={[styles.unitLabel, { color: colors.textSecondary }]}>{unitLabel}</Text>
          </Animated.View>
        </View>
        {showMax && (
          <TouchableOpacity
            onPress={() => onChangeText(SEND_MAX_VALUE)}
            style={[styles.maxButton, { backgroundColor: colors.fill }]}
          >
            <Text style={[styles.maxText, { color: colors.accent }]}>{t('send_max')}</Text>
          </TouchableOpacity>
        )}
      </View>
      {secondaryText != null && (
        <Text style={[styles.secondaryAmount, { color: colors.textSecondary }]}>{secondaryText}</Text>
      )}
    </View>
  )
}

// Keep legacy export name for backward compatibility during migration
export const SatsAmountInput = AmountInput

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  input: {
    ...typography.largeTitle,
    fontVariant: ['tabular-nums'],
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  unitLabelPressable: {
    paddingRight: spacing.sm
  },
  unitLabel: {
    ...typography.footnote
  },
  secondaryAmount: {
    ...typography.title3,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  maxButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    marginRight: spacing.sm
  },
  maxText: {
    ...typography.footnote,
    fontWeight: '600'
  },
  sendMaxDisplay: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  sendMaxLabel: {
    ...typography.body,
    fontWeight: '600'
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  }
})
