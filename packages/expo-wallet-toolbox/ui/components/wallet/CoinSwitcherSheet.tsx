/**
 * The coin switcher drawer (design "1b", 2026-09-15).
 *
 * Home's "Your BSV ⌄" label is the switcher; this is what it opens. One row per
 * kind of money the wallet holds — BSV first, then every stablecoin — each with
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
import React from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { hitTargets, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import type { TokenBalance } from '../../../core/mandala/runtime'
import Sheet from '../ui/Sheet'
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
const BSV_LABEL = 'BSV'

export interface CoinSwitcherSheetProps {
  visible: boolean
  onClose: () => void
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

export default function CoinSwitcherSheet({
  visible,
  onClose,
  balances,
  selected,
  onSelect,
  bsv,
  bsvContext
}: CoinSwitcherSheetProps) {
  const { t } = useTranslation()
  const choose = (assetId: string | null) => {
    onSelect(assetId)
    onClose()
  }
  return (
    <Sheet visible={visible} onClose={onClose} fitContent heightPercent={0.85}>
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
    </Sheet>
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
      style={[styles.row, selected && { backgroundColor: colors.surfaceRaised }]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      // The checkmark is not the only signal: state travels with the element.
      accessibilityState={{ selected }}
      accessibilityLabel={[name, figureText].filter(Boolean).join(', ')}
    >
      {/* A lettered tile rather than an issuer logo: the wallet draws nothing
          it did not verify, and a ticker is a fact it holds. */}
      <View style={[styles.tile, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}>
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
  list: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: hitTargets.minimum,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: 16
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tileText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  body: { flex: 1, minWidth: 0 },
  name: { ...typography.body, fontWeight: '600' },
  detail: { ...typography.footnote, marginTop: 2, fontVariant: ['tabular-nums'] },
  figure: { ...typography.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
  unit: { ...typography.footnote },
  check: { width: 20, alignItems: 'center' }
})
