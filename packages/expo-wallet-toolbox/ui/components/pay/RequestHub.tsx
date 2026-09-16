/**
 * Get paid — the amount first, then how.
 *
 * The figure (or its absence: blank means the payer decides) is the one thing
 * every receive method shares, so it is asked once, here, and carried into
 * whichever code is shown next. The three rows are the methods; nothing on
 * this screen is gated on the amount, because an open request is a real
 * request.
 */
import React from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import PayCellRow from './PayCellRow'
import AssetPicker from './AssetPicker'
import { ConsequenceNote, PayAmountField, PayField } from './PayForm'
import { spacing } from '@bsv/expo-wallet-toolbox'
import type { TokenAssetStatus, TokenBalance } from '../../../core/mandala/runtime'

export type RequestMethod = 'get-nearby' | 'get-handle' | 'get-address'

export interface RequestHubProps {
  /**
   * Raw figure from the amount field. '' is an open request. Satoshis when no
   * asset is selected, base units of that asset when one is — which is exactly
   * why the screen above must not hand this to a satoshi-shaped prop.
   */
  requestSats: string
  onChangeRequestSats: (v: string) => void
  onPick: (method: RequestMethod) => void
  online: boolean
  /** Held assets; empty means no picker and today's screen. */
  balances?: TokenBalance[]
  /** `null` is BSV. */
  selectedAssetId?: string | null
  onSelectAsset?: (assetId: string | null) => void
  /**
   * Regulatory/registry facts for `selectedAssetId`, from the caller's own
   * `useAssetStatus` — this component stays a plain prop-driven view (like
   * `balances` above) rather than reaching for the runtime itself. `null`
   * (unknown/no asset) shows no note; advisory only, since a paused issuer
   * can still resume before the payer ever acts on this request.
   */
  assetStatus?: TokenAssetStatus | null
}

/** Satoshis from the hub's raw field, or undefined for an open request. */
export function requestSatsFrom(text: string): number | undefined {
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export default function RequestHub({
  requestSats,
  onChangeRequestSats,
  onPick,
  online,
  balances = [],
  selectedAssetId = null,
  onSelectAsset,
  assetStatus = null
}: RequestHubProps) {
  const { t } = useTranslation()
  const holding = balances.find(b => b.asset.assetId === selectedAssetId) ?? null
  const asset = holding?.asset ?? null
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {balances.length > 0 && onSelectAsset && (
        <PayField labelKey="pay_asset_label_get">
          <AssetPicker
            balances={balances}
            selected={selectedAssetId}
            onSelect={id => {
              onSelectAsset(id)
              // The figure means something different in the new unit.
              onChangeRequestSats('')
            }}
            // A payee's own balance says nothing about what they are asking
            // for, and printing it here would imply it did.
            showFigures={false}
          />
        </PayField>
      )}

      {/* No max button and no balance line: this asks the PAYER for money, so
          the requester's own balance is meaningless here. */}
      <PayAmountField
        value={requestSats}
        onChangeText={onChangeRequestSats}
        showMax={false}
        showBalance={false}
        asset={asset ? { ticker: asset.ticker, decimals: asset.decimals } : undefined}
      />

      {/* Advisory only: a paused issuer can resume before the payer ever acts
          on this request, so this never blocks picking a method. */}
      {asset && assetStatus?.paused && (
        <ConsequenceNote
          textKey="pay_asset_request_paused"
          values={{ issuer: asset.issuerName || t('token_issuer_fallback'), ticker: asset.ticker }}
        />
      )}

      <PayField labelKey="pay_method">
        <View style={styles.rows}>
          <PayCellRow
            title={t('pay_method_nearby')}
            subtitle={t('pay_cell_nearby_get_sub')}
            icon="qr-code-outline"
            onPress={() => onPick('get-nearby')}
          />
          {/* Remote and address both need the network: a message-box round-trip
              and an overlay lookup respectively. Nearby is the offline rail.
              With an asset selected the link names it and carries the figure
              in its base units (`asset=`/`amount=`), so the row reads the same
              in either money. */}
          <PayCellRow
            title={t('pay_method_remote_link')}
            subtitle={!online ? t('pay_offline_needs_internet') : t('pay_cell_handle_get_sub')}
            icon="share-outline"
            disabled={!online}
            onPress={() => onPick('get-handle')}
          />
          {/* D4: disabled with a plain reason, never removed. Deleting one of
              three rows the user has learned would be a silent answer to a
              question they are entitled to have answered. */}
          <PayCellRow
            title={t('pay_method_address')}
            subtitle={
              asset
                ? t('pay_asset_address_status', { ticker: asset.ticker })
                : online
                  ? t('pay_cell_address_get_sub')
                  : t('pay_offline_needs_internet')
            }
            icon="wallet-outline"
            disabled={!online || !!asset}
            onPress={() => onPick('get-address')}
          />
        </View>
      </PayField>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  rows: { gap: spacing.md }
})
