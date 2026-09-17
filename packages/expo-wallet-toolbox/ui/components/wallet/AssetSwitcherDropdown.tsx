/**
 * The coin switcher dropdown (design 4a, 2026-09-16).
 *
 * Home's coin pill, now in the top bar, IS the switcher; this is what it
 * opens — a small card anchored just under the top bar, with a tail
 * pointing back at the pill, rather than a bottom drawer. One row per kind
 * of money the wallet holds — BSV first, then every stablecoin — each with
 * its figure, and a checkmark on the one the screen is currently showing.
 * Picking a row swaps the whole wallet to that coin: hero figure, activity
 * list, and what Pay / Get paid are armed with. The asset question is asked
 * here, once, so the Pay screen never has to ask it again.
 *
 * Only BSV gets a second line of conversions: the wallet has no price for a
 * token, and a converted figure beside one would be the wallet vouching for
 * someone else's peg (ux §6.1). A token's second line names its issuer instead.
 *
 * Rendered only when something is held — a wallet that has never held a token
 * never mounts this, so it keeps today's screen byte for byte.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useTranslation } from 'react-i18next'
import { hitTargets, radii, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import type { TokenBalance } from '../../../core/mandala/runtime'
import { tokenAmountParts } from '../../tokenFormat'

/**
 * @expo/vector-icons' index barrel re-exports every icon set, one of which
 * reaches expo-font -> expo-asset -- untransformed ESM Jest cannot parse when
 * eagerly pulled in via the `ui` package barrel. Loaded lazily, same pattern
 * as this package's other native-module-boundary fixes.
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

/** The literal, like `mainnet`/`testnet`: a translated "BSV" would be byte-identical in every locale. */
export const BSV_LABEL = 'BSV'

export interface AssetSwitcherDropdownProps {
  visible: boolean
  onClose: () => void
  /** Where the top bar ends, in the same coordinate space this component is
   *  mounted in — the card hangs just under it, tail pointing up at the pill. */
  top: number
  /** Held stablecoins, in the order the runtime reports them. */
  balances: TokenBalance[]
  /** `null` is BSV. */
  selected: string | null
  onSelect: (assetId: string | null) => void
  /** The BSV figure as the hero draws it; `null` is UNKNOWN and prints nothing. */
  bsv: { value: string; unit: string } | null
  /** The BSV row's second line: the same money in the other denominations. */
  bsvContext?: string
}

export default function AssetSwitcherDropdown({
  visible,
  onClose,
  top,
  balances,
  selected,
  onSelect,
  bsv,
  bsvContext
}: AssetSwitcherDropdownProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()

  // Fade + scale in place, no gesture — this is a dropdown, not a draggable
  // drawer. Mirrors Sheet's rendered/visible split so content unmounts only
  // once the close animation actually finishes, not the instant the prop flips.
  const [rendered, setRendered] = useState(false)
  const wasVisibleRef = useRef(false)
  const progress = useSharedValue(0)

  useEffect(() => {
    if (visible) {
      setRendered(true)
      if (!wasVisibleRef.current) {
        progress.value = 0
        progress.value = withTiming(1, { duration: 160 })
      }
    } else if (wasVisibleRef.current) {
      progress.value = withTiming(0, { duration: 120 }, finished => {
        if (finished) runOnJS(setRendered)(false)
      })
    }
    wasVisibleRef.current = visible
  }, [visible, progress])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + progress.value * 0.05 }, { translateY: (1 - progress.value) * -4 }]
  }))

  const isVisible = visible || rendered
  if (!isVisible) return null

  const choose = (assetId: string | null) => {
    onSelect(assetId)
    onClose()
  }

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 50 }]} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFill, { zIndex: 10 }]}
        onPress={onClose}
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel="Close"
        accessibilityHint="Dismisses the coin switcher"
      />
      <Animated.View
        style={[
          styles.card,
          {
            top: top + spacing.xs,
            backgroundColor: colors.surfaceRaised,
            borderColor: colors.surfaceRaisedBorder,
            shadowColor: colors.textPrimary
          },
          animatedStyle
        ]}
      >
        {/* The tail: a rotated square peeking out the top edge, pointing back
            at the pill that opened this — the pill sits centred in the top
            bar, and so does this card, so the tail needs no measurement. */}
        <View
          style={[styles.tail, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
        />
        <View style={styles.list}>
          <CoinRow
            glyph={BSV_LABEL}
            name={BSV_LABEL}
            detail={bsvContext}
            figure={bsv}
            selected={selected === null}
            onPress={() => choose(null)}
          />
          {balances.map(b => (
            <CoinRow
              key={b.asset.assetId}
              glyph={b.asset.ticker}
              name={b.asset.label || b.asset.ticker}
              detail={b.asset.issuerName || t('token_issuer_fallback')}
              figure={tokenAmountParts(b.baseUnits, b.asset)}
              selected={selected === b.asset.assetId}
              onPress={() => choose(b.asset.assetId)}
            />
          ))}
        </View>
      </Animated.View>
    </View>
  )
}

function CoinRow({
  glyph,
  name,
  detail,
  figure,
  selected,
  onPress
}: {
  glyph: string
  name: string
  detail?: string
  figure: { value: string; unit: string } | null
  selected: boolean
  onPress: () => void
}) {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const figureText = figure ? `${figure.value} ${figure.unit}`.trim() : ''
  return (
    <TouchableOpacity
      style={[styles.row, selected && { backgroundColor: colors.fill }]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      // The checkmark is not the only signal: state travels with the element.
      accessibilityState={{ selected }}
      accessibilityLabel={[name, figureText].filter(Boolean).join(', ')}
    >
      {/* A lettered tile rather than an issuer logo: the wallet draws nothing
          it did not verify, and a ticker is a fact it holds. */}
      <View style={[styles.tile, { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }]}>
        <Text style={[styles.tileText, { color: colors.textPrimary }]} numberOfLines={1}>
          {glyph.slice(0, 4).toUpperCase()}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
        {!!detail && (
          <Text style={[styles.detail, { color: colors.textSecondary }]} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {figure && (
        <Text style={[styles.figure, { color: colors.textPrimary }]} numberOfLines={1} accessibilityLabel={figureText}>
          {figure.value}
          {figure.unit ? <Text style={[styles.unit, { color: colors.textSecondary }]}> {figure.unit}</Text> : null}
        </Text>
      )}
      <View style={styles.check}>{selected && <Ionicons name="checkmark" size={20} color={colors.accent} />}</View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'visible',
    zIndex: 20,
    elevation: 12,
    // Deep and soft rather than tight — the card has to sit clearly in front
    // of the dimmed page behind it, and a small shadow reads as a seam.
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.22,
    shadowRadius: 30
  },
  tail: {
    position: 'absolute',
    top: -6,
    alignSelf: 'center',
    width: 12,
    height: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 3,
    transform: [{ rotate: '45deg' }]
  },
  list: {
    padding: spacing.xs,
    borderRadius: radii.xl,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: hitTargets.minimum,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.lg
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tileText: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
  body: { flex: 1, minWidth: 0 },
  name: { ...typography.body, fontWeight: '600' },
  detail: { ...typography.footnote, marginTop: 2, fontVariant: ['tabular-nums'] },
  figure: { ...typography.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
  unit: { ...typography.footnote },
  check: { width: 20, alignItems: 'center' }
})
