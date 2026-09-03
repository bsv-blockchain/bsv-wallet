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
import { PayAmountField, PayField } from './PayForm'
import { spacing } from '@bsv/expo-wallet-toolbox'

export type RequestMethod = 'get-nearby' | 'get-handle' | 'get-address'

export interface RequestHubProps {
  /** Raw satoshi string from the amount field. '' is an open request. */
  requestSats: string
  onChangeRequestSats: (v: string) => void
  onPick: (method: RequestMethod) => void
  online: boolean
}

/** Satoshis from the hub's raw field, or undefined for an open request. */
export function requestSatsFrom(text: string): number | undefined {
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export default function RequestHub({ requestSats, onChangeRequestSats, onPick, online }: RequestHubProps) {
  const { t } = useTranslation()
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* No max button and no balance line: this asks the PAYER for money, so
          the requester's own balance is meaningless here. */}
      <PayAmountField value={requestSats} onChangeText={onChangeRequestSats} showMax={false} showBalance={false} />

      <PayField labelKey="pay_method">
        <View style={styles.rows}>
          <PayCellRow
            title={t('pay_method_nearby')}
            subtitle={t('pay_cell_nearby_get_sub')}
            icon="qr-code-outline"
            onPress={() => onPick('get-nearby')}
          />
          {/* Remote and address both need the network: a message-box round-trip
              and an overlay lookup respectively. Nearby is the offline rail. */}
          <PayCellRow
            title={t('pay_method_remote_link')}
            subtitle={online ? t('pay_cell_handle_get_sub') : t('pay_offline_needs_internet')}
            icon="share-outline"
            disabled={!online}
            onPress={() => onPick('get-handle')}
          />
          <PayCellRow
            title={t('pay_method_address')}
            subtitle={online ? t('pay_cell_address_get_sub') : t('pay_offline_needs_internet')}
            icon="wallet-outline"
            disabled={!online}
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
