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
import { parseTokenAmount, tokenAmountInputText, tokenAmountMask } from '../../tokenFormat'

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

/** The denomination an amount is being typed in, when it is not satoshis. */
export interface AmountInputAsset {
  ticker: string
  decimals: number
}

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
  /**
   * Token mode. When present the field takes and emits BASE UNITS of this
   * asset instead of satoshis, and — this is the whole of the change — every
   * fiat branch below goes inert, because `isFiat` is conjoined with
   * `asset == null`. Without that single conjunction the fiat resync effect
   * would take base units, divide them by a satoshi/fiat rate and clobber the
   * figure the user typed.
   */
  asset?: AmountInputAsset
  /**
   * Token mode only: what Max writes. The satoshi sentinel is a satoshi-domain
   * concept and never enters token code — here Max writes the real spendable
   * figure, which is exact because a token output carries 1 satoshi and the
   * fee comes out of BSV.
   */
  maxValue?: string
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
  maxLabelKey = 'entire_wallet_balance',
  asset,
  maxValue
}) => {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const reducedMotion = useReducedMotion()
  const Ionicons = loadIonicons()

  const currency = settings?.currency || 'BSV'
  // ONE conjunction, and it is what keeps three denominations from colliding:
  // in asset mode every fiat branch below is unreachable, unchanged.
  const isFiat = asset == null && isFiatCurrency(currency)
  const fractionDigits = asset ? asset.decimals : isFiat ? fiatFractionDigits(currency) : 0
  const isSendMax = asset == null && value === SEND_MAX_VALUE

  // In fiat and asset modes alike, the text being typed is not the value being
  // emitted, so the field keeps its own display string.
  const [displayText, setDisplayText] = useState('')
  const lastEmitted = useRef('')

  // Sync fiat display value when the satoshi value changes externally (e.g., cleared by parent)
  useEffect(() => {
    if (!isFiat) return
    // Avoid re-syncing when we caused the change ourselves
    if (value === lastEmitted.current) return

    if (!value || value === '0') {
      setDisplayText('')
    } else if (value === SEND_MAX_VALUE) {
      // Don't try to convert SEND_MAX_VALUE to fiat
    } else {
      const sats = parseInt(value, 10)
      const per = satoshisPerFiatUnit(currency, satoshisPerUSD, usdToFiat)
      if (!isNaN(sats) && per > 0) {
        const amount = sats / per
        if (fractionDigits === 0) {
          setDisplayText(String(Math.round(amount)))
        } else {
          setDisplayText(
            amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(fractionDigits).replace(/0+$/, '').replace(/\.$/, '')
          )
        }
      }
    }
    lastEmitted.current = value
  }, [value, isFiat, currency, satoshisPerUSD, usdToFiat, fractionDigits])

  // The asset-mode twin of the effect above, with the same self-resync guard.
  // The two are mutually exclusive by mode and neither can run in the other's.
  useEffect(() => {
    if (!asset) return
    if (value === lastEmitted.current) return
    setDisplayText(!value || value === '0' ? '' : tokenAmountInputText(Number(value), asset.decimals))
    lastEmitted.current = value
    // `asset` is a fresh object literal on every render of most callers
    // (e.g. `asset={{ ticker, decimals }}`), so depending on it directly
    // reruns this effect on EVERY parent render, not just when the figure
    // actually changes. Two such reruns queued back to back can interleave
    // out of order — an older render's effect (with a stale `value`) firing
    // AFTER a newer one clobbers `lastEmitted.current` back down, which then
    // makes the newer render's own effect think it must resync and reformats
    // what the user just typed. Depending on the primitive that the effect
    // body actually reads keeps it from firing on an unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, asset?.decimals, !!asset])

  const handleChangeText = (text: string) => {
    if (asset) {
      if (text && !tokenAmountMask(asset.decimals).test(text)) return
      setDisplayText(text)
      const baseUnits = parseTokenAmount(text, asset.decimals)
      // The field never emits a fraction: the wire takes whole base units, and
      // a rounded figure would pay an amount other than the one on screen.
      const next = baseUnits === null ? '' : String(baseUnits)
      lastEmitted.current = next
      onChangeText(next)
      return
    }
    if (isFiat) {
      const allowed = fractionDigits === 0 ? /^\d*$/ : new RegExp(`^\\d*\\.?\\d{0,${fractionDigits}}$`)
      if (text && !allowed.test(text)) return
      setDisplayText(text)
      const sats = parseDisplayToSatoshis(text, currency, satoshisPerUSD, usdToFiat)
      const satsStr = text ? String(sats) : ''
      lastEmitted.current = satsStr
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
            if (isFiat) setDisplayText('')
            onChangeText('')
          }}
          style={[styles.clearButton, { backgroundColor: colors.fill }]}
        >
          <Ionicons name="close" size={16} color={colors.accent} />
        </TouchableOpacity>
      </View>
    )
  }

  const displayValue = isFiat || asset ? displayText : value
  const placeholder = fractionDigits === 0 ? '0' : `0.${'0'.repeat(Math.min(fractionDigits, 8))}`
  const keyboardType = fractionDigits > 0 ? ('decimal-pad' as const) : ('number-pad' as const)
  const unitLabel = asset ? asset.ticker : isFiat ? currency : 'satoshis'

  // Secondary converted-currency line: BSV when showing fiat, USD when showing BSV.
  // Suppressed entirely in asset mode — this wallet has no price for a token,
  // and a converted line under a stablecoin figure would be invented.
  const satsForConversion = !asset && value ? parseInt(value, 10) : 0
  const secondaryText = asset
    ? null
    : isFiat
      ? satsForConversion > 0
        ? formatAmount(satsForConversion, 'BSV', satoshisPerUSD)
        : null
      : satsForConversion > 0 && satoshisPerUSD > 0
        ? formatAmount(satsForConversion, 'USD', satoshisPerUSD)
        : null

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
            onPress={() => onChangeText(asset ? (maxValue ?? '') : SEND_MAX_VALUE)}
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
