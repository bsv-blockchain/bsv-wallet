/**
 * One held asset, on Home.
 *
 * Every state here is rendered through existing `ListRow` props — no new row
 * component, no new geometry — because a token balance is not a different kind
 * of thing from the rows this wallet already draws; it is the same row with a
 * money figure in `trailing` rather than a settings value in `value`
 * (`ListRow.value` is typed as a settings string and styled as one).
 *
 * The subtitle is where every qualifier lives, and there is at most one:
 *
 *  · never opened → "New — tap to see who issues it", which is how disclosure
 *    is discovered without an unprompted sheet on the most-used screen;
 *  · some of it arrived offline and the issuer has not confirmed it yet →
 *    "Received offline · not yet confirmed by {{issuer}}". The figure still
 *    includes those units, because they ARE spendable (the offline-settlement
 *    model credits at COVER, not at broadcast) — what is unconfirmed is the
 *    issuer's word, and saying so is the whole of principle 4.
 *
 * A healthy row carries no chroma at all: chroma in this app means transaction
 * status, and a balance is not a status.
 */
import React from 'react'
import { View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@bsv/expo-wallet-toolbox'
import { ListRow } from '../ui/ListRow'
import type { TokenAssetStatus, TokenBalance } from '../../../core/mandala/runtime'
import AssetAmount from './AssetAmount'
import { formatTokenAmount, formatTokenAmountWithUnit } from '../../tokenFormat'

export interface AssetRowProps {
  balance: TokenBalance
  /** The sheet has never been opened for this asset (persisted by the caller). */
  isNew?: boolean
  isLast?: boolean
  /** Regulatory/registry facts for this asset. `null` = not known yet. */
  status?: TokenAssetStatus | null
  onPress: () => void
}

export default function AssetRow({ balance, isNew = false, isLast = false, status = null, onPress }: AssetRowProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { asset, baseUnits, unsettledBaseUnits } = balance
  const issuer = asset.issuerName || t('token_issuer_fallback')

  // Row states (ux design §2.1), one at a time, in priority order: an
  // unresolved asset cannot even be named, so it pre-empts everything else;
  // paused and frozen are both real regulatory facts and outrank the merely
  // informational "not yet confirmed"/"new" subtitles.
  const unresolved = status?.metadataResolved === false
  const paused = !unresolved && status?.paused === true
  const frozenBaseUnits = !unresolved && !paused ? (status?.frozenBaseUnits ?? 0) : 0

  const subtitle = unresolved
    ? t('token_unresolved_sub')
    : paused
      ? t('token_paused_short')
      : frozenBaseUnits > 0
        ? t('token_frozen_short', { amount: formatTokenAmount(frozenBaseUnits, asset.decimals) ?? '' })
        : unsettledBaseUnits > 0
          ? t('local_pay_token_not_cleared', { issuer })
          : isNew
            ? t('token_new_tap')
            : undefined

  const icon = unresolved ? 'help-circle-outline' : paused ? 'pause-circle-outline' : frozenBaseUnits > 0 ? 'snow-outline' : 'cash-outline'
  const iconColor = paused || frozenBaseUnits > 0 ? colors.warning : undefined

  const figure = unresolved ? undefined : formatTokenAmountWithUnit(baseUnits, asset)
  const label = unresolved ? t('token_unresolved') : asset.label || asset.ticker

  return (
    // One accessibility element, not three: the name and the figure are one
    // fact, and a hint that names what the tap opens (§9).
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={[label, figure, subtitle].filter(Boolean).join(', ')}
      accessibilityHint={t('token_row_hint')}
    >
      <ListRow
        label={label}
        subtitle={subtitle}
        icon={icon}
        iconColor={iconColor}
        isLast={isLast}
        onPress={onPress}
        trailing={unresolved ? undefined : <AssetAmount baseUnits={baseUnits} asset={asset} size="row" />}
      />
    </View>
  )
}
