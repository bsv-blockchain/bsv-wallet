/**
 * "Paying with" / "Getting paid in" — the asset question, asked inside the flow
 * that already asks who and how much.
 *
 * The asset is a property of a payment, not a mode of the wallet: there is no
 * token screen to switch into and no setting to change, because a person who
 * holds two kinds of money does not want a second wallet, they want to choose
 * once, here, at the moment it matters.
 *
 * It sits ABOVE the recipient field on purpose. Choosing an asset changes the
 * unit of the amount, the available figure and which recipient shapes are even
 * legal (a token has no address rail), so asking it second would silently
 * invalidate work the user had already done.
 *
 * The control is the display-currency expander from Settings, verbatim: a row
 * with a down-chevron that opens an inline list with a trailing checkmark. Not
 * a segmented control — that caps out at four options and this list is as long
 * as the user's holdings. It is layout, not animation, so Reduce Motion needs
 * no special case.
 *
 * Renders `null` when the wallet holds no token, which is the whole of "a
 * wallet that has never held one renders today's screen".
 */
import React, { useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { hitTargets, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import type { TokenBalance } from '../../../core/mandala/runtime'
import { ListRow } from '../ui/ListRow'
import { formatTokenAmountWithUnit } from '../../tokenFormat'

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

/**
 * The BSV row's label is the literal string, like `mainnet`/`testnet` elsewhere
 * in this app: a `pay_asset_bsv` key would be byte-identical in all twelve
 * locales and fail translation parity for being untranslated.
 */
const BSV_LABEL = 'BSV'

export interface AssetPickerProps {
  /** Held assets. Empty means no picker at all. */
  balances: TokenBalance[]
  /** `null` selects BSV — the default, and what every existing flow assumes. */
  selected: string | null
  onSelect: (assetId: string | null) => void
  /** Shown beside the BSV row; `null` is UNKNOWN and prints nothing. */
  bsvBalanceText?: string | null
  /** Whether the collapsed row shows each asset's figure (Pay does; Get paid doesn't). */
  showFigures?: boolean
}

export default function AssetPicker({
  balances,
  selected,
  onSelect,
  bsvBalanceText = null,
  showFigures = true
}: AssetPickerProps) {
  const { colors } = useTheme()
  const [expanded, setExpanded] = useState(false)

  if (balances.length === 0) return null

  const current = balances.find(b => b.asset.assetId === selected) ?? null
  const currentLabel = current ? current.asset.label || current.asset.ticker : BSV_LABEL
  const currentFigure = current
    ? formatTokenAmountWithUnit(current.baseUnits, current.asset)
    : bsvBalanceText

  const choose = (assetId: string | null) => {
    onSelect(assetId)
    setExpanded(false)
  }

  return (
    <View>
      <View
        accessible
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={[currentLabel, showFigures ? currentFigure : null].filter(Boolean).join(', ')}
      >
        <ListRow
          label={currentLabel}
          value={showFigures && currentFigure ? currentFigure : undefined}
          icon="cash-outline"
          isLast={!expanded}
          onPress={() => setExpanded(e => !e)}
          showChevron
          chevronDown
        />
      </View>
      {expanded && (
        <View style={[styles.options, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          <AssetOption
            label={BSV_LABEL}
            figure={showFigures ? bsvBalanceText : null}
            selected={selected === null}
            onPress={() => choose(null)}
          />
          {balances.map(b => (
            <AssetOption
              key={b.asset.assetId}
              label={b.asset.label || b.asset.ticker}
              figure={showFigures ? formatTokenAmountWithUnit(b.baseUnits, b.asset) : null}
              selected={selected === b.asset.assetId}
              onPress={() => choose(b.asset.assetId)}
            />
          ))}
        </View>
      )}
    </View>
  )
}

function AssetOption({
  label,
  figure,
  selected,
  onPress
}: {
  label: string
  figure?: string | null
  selected: boolean
  onPress: () => void
}) {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <TouchableOpacity
      style={styles.option}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      // The checkmark is not the only signal: state travels with the element.
      accessibilityState={{ selected }}
      accessibilityLabel={[label, figure].filter(Boolean).join(', ')}
    >
      <Text style={[styles.optionLabel, { color: colors.textPrimary }]} numberOfLines={1}>
        {label}
      </Text>
      {!!figure && (
        <Text style={[styles.optionFigure, { color: colors.textSecondary }]} numberOfLines={1}>
          {figure}
        </Text>
      )}
      {selected && <Ionicons name="checkmark" size={20} color={colors.accent} style={styles.check} />}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  options: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: hitTargets.minimum,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  optionLabel: { ...typography.body, flex: 1 },
  optionFigure: { ...typography.footnote, fontVariant: ['tabular-nums'] },
  check: { marginLeft: spacing.xs }
})
