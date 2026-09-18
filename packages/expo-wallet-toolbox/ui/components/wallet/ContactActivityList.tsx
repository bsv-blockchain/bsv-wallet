/**
 * The "ACTIVITY" block of a contact: every interaction with them, drawn with
 * the SAME row Home uses (sigil tile, description, status dot + time, the
 * figure in the display currency with the other denomination beneath), so a
 * payment looks identical whether you find it on Home or on the person.
 *
 * A token settlement has no wallet action of its own here — `getContactActivity`
 * reads it straight off `token_settlements` — so this builds the minimal
 * action `ActivityRow` needs around it and hands the token facts through the
 * row's own `token` prop, exactly as Home does for a `'mandala'`-labelled row.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import ActivityRow, { type ActivityAction } from './ActivityRow'
import { showToast } from '../ui/Toast'
import { useMandala } from '../../hooks/useMandala'
import { formatTokenAmount } from '../../tokenFormat'
import { tokenStatusKey } from '../../tokenStatus'
import type { TokenActivityStatus } from '../../../core/mandala/runtime'
import type { ContactActivityItem, ContactSettlementRow } from '../../../core/contacts/contactActivity'

/** Same reading of a settlement's `state` as the runtime's `activityStatusOf`,
 * minus the "stuck after N hours" clock — a contact page is a record, not a
 * queue, so an old unsettled row reads as "settling" rather than as a fault
 * to act on (the acting happens on Home). */
function statusOf(row: ContactSettlementRow): TokenActivityStatus {
  switch (row.state) {
    case 'broadcast':
    case 'admitted':
      return 'settled'
    case 'refused':
      return 'refused'
    case 'orphaned':
      return 'reversed'
    default:
      return 'settling'
  }
}

const noop = () => {}

export default function ContactActivityList({
  items,
  identityKey
}: {
  items: ContactActivityItem[]
  identityKey: string
}) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings, selectedNetwork } = useWallet()
  const mandala = useMandala()
  const currency = settings?.currency || 'BSV'
  const [expanded, setExpanded] = useState<string | null>(null)
  const onToggle = useCallback((key: string) => setExpanded(prev => (prev === key ? null : key)), [])

  const onExplorer = useCallback(
    (txid: string) => {
      const base =
        selectedNetwork === 'main'
          ? 'https://whatsonchain.com'
          : selectedNetwork === 'teratest'
            ? 'https://woc-ttn.bsvblockchain.tech'
            : 'https://test.whatsonchain.com'
      Linking.openURL(`${base}/tx/${txid}`).catch(() => showToast(t('explorer_open_failed'), { type: 'error' }))
    },
    [selectedNetwork, t]
  )

  const rows = useMemo(
    () =>
      items.map(item => {
        const key = `${item.kind}:${item.txid}`
        if (item.kind === 'bsv') {
          return { key, action: item as unknown as ActivityAction, token: undefined }
        }
        const holding = (mandala.balances ?? []).find(b => b.asset.assetId === item.assetId)
        const ticker = holding?.asset.ticker ?? item.assetId.slice(0, 8)
        const incoming = item.role === 'received'
        const figure =
          holding && item.amountBaseUnits !== undefined
            ? formatTokenAmount(incoming ? item.amountBaseUnits : -item.amountBaseUnits, holding.asset.decimals, {
                showPlus: incoming
              })
            : undefined
        const action: ActivityAction = {
          txid: item.txid,
          satoshis: 0,
          status: 'completed',
          isOutgoing: !incoming,
          description: '',
          labels: ['mandala'],
          created_at: item.createdAt
        } as unknown as ActivityAction
        return {
          key,
          action,
          token: {
            title: t(incoming ? 'token_row_received' : 'token_row_sent', { ticker }),
            amount: figure ? { value: figure, unit: ticker } : undefined,
            incoming,
            counterpartyKey: identityKey,
            statusText: t(tokenStatusKey(statusOf(item)))
          }
        }
      }),
    [items, mandala.balances, identityKey, t]
  )

  if (rows.length === 0) {
    return <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('contact_activity_empty')}</Text>
  }

  return (
    <View>
      {rows.map(({ key, action, token }, idx) => (
        <View
          key={key}
          style={
            idx < rows.length - 1 && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.separator
            }
          }
        >
          <ActivityRow
            currency={currency}
            action={action}
            rowKey={key}
            token={token}
            expanded={expanded === key}
            busy={false}
            onToggle={onToggle}
            onExplorer={onExplorer}
            onRefreshTx={noop}
            onAbort={noop}
          />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  empty: { ...typography.footnote, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm }
})
