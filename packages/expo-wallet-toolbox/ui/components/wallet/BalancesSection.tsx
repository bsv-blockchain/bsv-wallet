/**
 * The BALANCES block on Home — one row per held asset, and nothing at all
 * otherwise.
 *
 * This is the whole of "hidden until relevant" (ux §2): a wallet that has never
 * held a token renders `null` here, so Home is byte-identical to today's. There
 * is no empty state, no "no tokens yet", and no "add a token" — none of those
 * is a fact about this wallet, and every one of them would be a permanent
 * advertisement on the screen people open most.
 *
 * The footer appears on exactly one condition: the fee balance is provably
 * zero. `useSpendableBalance()` returns `null` on every cold open and for the
 * whole window after a network switch, and `null < 1` is `true` in JavaScript —
 * so the check is `=== 0`, never `< n`, or the wallet tells a user with fifty
 * million satoshis that they need BSV.
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { GroupedSection } from '../ui/GroupedList'
import type { TokenAssetStatus, TokenBalance } from '../../../core/mandala/runtime'
import AssetRow from './AssetRow'

export interface BalancesSectionProps {
  /** Held assets. `null` (unknown) and `[]` (none) both render nothing. */
  balances: TokenBalance[] | null
  /** The wallet's spendable satoshis, `null` when unknown. */
  spendableSats?: number | null
  /** Asset ids whose sheet has never been opened. */
  newAssetIds?: readonly string[]
  /** Regulatory/registry facts per held asset, by assetId. Missing = not known yet. */
  statusByAsset?: Readonly<Record<string, TokenAssetStatus>>
  onPress: (assetId: string) => void
}

export default function BalancesSection({
  balances,
  spendableSats = null,
  newAssetIds = [],
  statusByAsset,
  onPress
}: BalancesSectionProps) {
  const { t } = useTranslation()
  if (!balances || balances.length === 0) return null

  const showFeeFooter = spendableSats === 0

  return (
    <GroupedSection
      header={t('token_balances_header')}
      footer={showFeeFooter ? t('token_fee_footer') : undefined}
    >
      {balances.map((balance, i) => (
        <AssetRow
          key={balance.asset.assetId}
          balance={balance}
          isNew={newAssetIds.includes(balance.asset.assetId)}
          isLast={i === balances.length - 1}
          status={statusByAsset?.[balance.asset.assetId] ?? null}
          onPress={() => onPress(balance.asset.assetId)}
        />
      ))}
    </GroupedSection>
  )
}
