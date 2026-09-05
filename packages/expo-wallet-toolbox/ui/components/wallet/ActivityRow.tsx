/**
 * One row of the wallet's activity list.
 *
 * Reading order is direction → what it was → how much, then status and time
 * underneath. The per-transaction utilities (status, explorer, resend, cancel)
 * are NOT on the row: they used to sit permanently on the right, four icons
 * deep, which made every row look equally busy whether or not anything needed
 * doing. They now live behind a tap, and the expanded row lifts onto its own
 * surface so it is obvious which transaction the chips belong to.
 *
 * The chips are what someone can DO about a payment. Copying raw BEEF or a
 * txid to a clipboard is not that — it is debugging, and it used to crowd out
 * the two chips that actually resolve a stuck payment.
 */
import React, { memo, useContext } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { WalletAction } from '@bsv/sdk'
import { useTheme, spacing, radii, typography, useWallet, ExchangeRateContext, formatAmount, formatAmountParts } from '@bsv/expo-wallet-toolbox'
import { txStatusView, toneColor } from '../../txStatus'
import PressableScale from '../ui/PressableScale'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Both icon sets are loaded lazily, only when actually rendering, same
 * pattern as this package's other native-module-boundary fixes (expo-router,
 * expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
type MaterialCommunityIconsComponent = typeof import('@expo/vector-icons').MaterialCommunityIcons
let ioniconsComponent: IoniconsComponent | undefined
let materialCommunityIconsComponent: MaterialCommunityIconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}
function loadMaterialCommunityIcons(): MaterialCommunityIconsComponent {
  if (!materialCommunityIconsComponent) {
    materialCommunityIconsComponent = require('@expo/vector-icons')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

/** A row as storage actually returns it: `reference` and `created_at` are real
 * columns the SDK's WalletAction type does not declare. */
export type ActivityAction = WalletAction & {
  reference?: string
  created_at?: string | number | Date
}

interface Props {
  /** Pass the screen currency to avoid subscribing every row to wallet updates. */
  currency?: string
  action: ActivityAction
  /** Identity of this row in the list's expanded/busy bookkeeping. Passed back
   * to `onToggle` so the handler can stay referentially stable across renders —
   * an inline closure here would defeat the memo below on every poll. */
  rowKey: string
  /** Live offline-queue state for this txid, when it has one. */
  offlineStatus?: string
  expanded: boolean
  busy: boolean
  /** What the spinner is waiting on. A bare spinner on a money row is a
   * question ("is it sending? cancelling?") the row can answer. */
  busyLabel?: string
  onToggle: (rowKey: string) => void
  onExplorer: (txid: string) => void
  onRefreshTx: (txid: string) => void
  onAbort: (reference: string) => void
  /** Rebuild and re-deliver a PeerPay token without waiting for a NACK. */
  onSendPaymentDetails?: (txid: string) => void
  /** Start a new payment (or retryDelivery) for a failed outbound row. */
  onSendAgain?: (action: ActivityAction) => void
  /** Cancel a parked payment: abort the action and retire its queue row. */
  onCancelParked?: (txid: string) => void
}

/** Statuses whose transaction is still local and therefore abortable: nothing
 * has been (successfully) broadcast, so releasing it is safe and frees the
 * inputs it reserved. `failed` is included because a failed action still holds
 * its input reservations until it is cleared. */
const ABORTABLE_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

/** Local time of day, e.g. "14:32". Empty when storage gave us no timestamp. */
export function formatRowTime(value?: string | number | Date): string {
  if (value === undefined || value === null) return ''
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

function ActivityRowBase({
  currency,
  action,
  rowKey,
  offlineStatus,
  expanded,
  busy,
  busyLabel,
  onToggle,
  onExplorer,
  onRefreshTx,
  onAbort,
  onSendPaymentDetails,
  onSendAgain,
  onCancelParked
}: Props & { currency: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const MaterialCommunityIcons = loadMaterialCommunityIcons()

  const view = txStatusView(action.status, offlineStatus)
  const settled = view.tone === 'settled'
  const tone = toneColor(view.tone, colors as unknown as Record<string, string>)
  const incoming = action.satoshis >= 0

  const { value, unit } = formatAmountParts(action.satoshis, currency, satoshisPerUSD, {
    abbreviate: true,
    showPlus: true,
    usdToFiat
  })
  // The second denomination — the one the user is NOT currently displaying. It
  // is the answer to "yes, but how much is that really", which is the whole
  // reason a sats-denominated wallet needs a fiat line at all.
  const secondary = formatAmount(action.satoshis, currency === 'BSV' ? 'USD' : 'BSV', satoshisPerUSD, {
    abbreviate: true,
    showPlus: true,
    usdToFiat
  })

  const time = formatRowTime(action.created_at)
  const amountColor = incoming ? colors.successAmount : colors.textPrimary
  const unitColor = incoming ? colors.successAmount : colors.textSecondary

  // A parked payment was built and shown as a code, but never released: it is
  // not on chain and no task will put it there. An explorer link would 404 and
  // a Refresh would ask the network about a transaction it has never seen, so
  // the row offers only the two things that apply. Resend goes out over the
  // message box rather than re-showing the code: if the payee is still standing
  // there, cancelling and starting again is both quicker and honest, and if
  // they are not, the remote rail is the only one that can still reach them.
  const parked = offlineStatus === 'parked'
  const canCancelParked = parked && !!action.txid && !!onCancelParked
  const canAbort = !parked && ABORTABLE_STATUSES.has(action.status) && !!action.reference
  // Any outgoing payment this wallet can rebuild: both rails write the payee's
  // identity key as a label and the derivation data as customInstructions, so
  // the details can be re-delivered whether the payment went out through a
  // message box or a nearby code that may never have been scanned.
  const resendableOutbound =
    !!action.txid &&
    (action.isOutgoing ?? !incoming) &&
    !!action.labels?.some(l => l === 'peerpay' || l === 'localpay')
  const canResendDetails = resendableOutbound && !!onSendPaymentDetails
  const canSendAgain = !parked && !incoming && action.status === 'failed' && !!onSendAgain
  const hasUtilities = parked
    ? canResendDetails || canCancelParked
    : !!action.txid || canAbort || canResendDetails || canSendAgain

  return (
    <View
      style={[
        expanded && {
          backgroundColor: colors.surfaceRowExpanded,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline
        }
      ]}
    >
      <PressableScale
        scaleTo={0.99}
        onPress={hasUtilities ? () => onToggle(rowKey) : undefined}
        style={styles.row}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={action.description || t('transactions')}
      >
        <View
          style={[
            styles.glyph,
            incoming
              ? {
                  backgroundColor: colors.successStrong + '1A',
                  borderColor: colors.successStrong + '2E'
                }
              : { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
          ]}
        >
          <MaterialCommunityIcons
            name={incoming ? 'arrow-bottom-left' : 'arrow-top-right'}
            size={16}
            color={incoming ? colors.successStrong : colors.textSecondary}
          />
        </View>

        <View style={styles.middle}>
          <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={1}>
            {action.description || t('transactions')}
          </Text>
          <View style={styles.statusLine}>
            <View
              style={[
                styles.dot,
                { backgroundColor: settled ? colors.successStrong : tone }
              ]}
            />
            <Text
              style={[styles.statusText, { color: settled ? colors.textSecondary : tone }]}
              numberOfLines={1}
            >
              {time ? `${t(view.key)} · ${time}` : t(view.key)}
            </Text>
          </View>
        </View>

        <View style={styles.amounts}>
          <Text style={[styles.amount, { color: amountColor }]}>
            {value}
            {unit ? <Text style={[styles.amountUnit, { color: unitColor }]}> {unit}</Text> : null}
          </Text>
          <Text style={[styles.amountSecondary, { color: colors.textTertiary }]}>{secondary}</Text>
        </View>
      </PressableScale>

      {expanded && hasUtilities ? (
        <View style={styles.chips}>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              {busyLabel ? (
                <Text style={[styles.busyLabel, { color: colors.textSecondary }]} numberOfLines={1}>
                  {busyLabel}
                </Text>
              ) : null}
            </View>
          ) : (
            <>
              {action.txid && !parked && offlineStatus !== 'queued' && offlineStatus !== 'posting' ? (
                <Chip
                  icon="refresh-outline"
                  label={t('tx_action_refresh_short')}
                  accessibilityLabel={t('tx_action_refresh')}
                  onPress={() => onRefreshTx(action.txid)}
                />
              ) : null}
              {action.txid && !parked ? (
                <Chip
                  icon="link-outline"
                  label="Explorer"
                  accessibilityLabel={t('tx_action_explorer')}
                  onPress={() => onExplorer(action.txid)}
                />
              ) : null}
              {canAbort ? (
                <Chip
                  icon="close-circle-outline"
                  label={t('cancel')}
                  accessibilityLabel={t('tx_action_abort')}
                  danger
                  onPress={() => onAbort(action.reference!)}
                />
              ) : null}
              {canResendDetails ? (
                <Chip
                  icon="send-outline"
                  label={t('tx_action_resend_short')}
                  accessibilityLabel={t('send_payment_details_again')}
                  onPress={() => onSendPaymentDetails!(action.txid)}
                />
              ) : null}
              {canCancelParked ? (
                <Chip
                  icon="close-circle-outline"
                  label={t('cancel')}
                  accessibilityLabel={t('pay_parked_cancel')}
                  danger
                  onPress={() => onCancelParked!(action.txid)}
                />
              ) : null}
              {canSendAgain ? (
                <Chip
                  icon="arrow-redo-outline"
                  label={t('send_again')}
                  accessibilityLabel={t('send_again')}
                  onPress={() => onSendAgain!(action)}
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {/* Inset to the description, not the screen edge: the rule separates the
          text columns, and the glyph tiles already read as separate objects. An
          expanded row is bounded by its own surface, so it needs no rule. */}
      {expanded ? null : (
        <View style={[styles.separator, { backgroundColor: colors.hairline }]} />
      )}
    </View>
  )
}

function Chip({
  icon,
  label,
  accessibilityLabel,
  onPress,
  danger
}: {
  icon: keyof IoniconsComponent['glyphMap']
  label: string
  accessibilityLabel: string
  onPress: () => void
  danger?: boolean
}) {
  const { colors } = useTheme()
  const color = danger ? colors.error : colors.textSecondary
  const Ionicons = loadIonicons()
  return (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      style={[
        styles.chip,
        { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[styles.chipLabel, { color }]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: 13,
    paddingBottom: 11
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  middle: { flex: 1, minWidth: 0 },
  // 14.5/500 rather than body 17/400: the row is scanned, not read, and at 17pt
  // the description crowds the amount on narrow phones.
  description: { fontSize: 14.5, fontWeight: '500', letterSpacing: -0.1, lineHeight: 19 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  statusText: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  amounts: { alignItems: 'flex-end' },
  amount: { fontSize: 14.5, fontWeight: '600', lineHeight: 19, fontVariant: ['tabular-nums'] },
  amountUnit: { fontSize: 12, fontWeight: '500' },
  amountSecondary: { fontSize: 11.5, lineHeight: 15, marginTop: 2, fontVariant: ['tabular-nums'] },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingLeft: 70, // aligns the chip row with the description, past the glyph
    paddingRight: spacing.xl,
    paddingTop: 2,
    paddingBottom: 14
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 8 },
  busyLabel: { ...typography.subhead },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  chipLabel: { fontSize: 12, fontWeight: '600' }
})

// Compare every prop: callbacks and busyLabel must also update, otherwise a
// retained row can invoke a previous network's handler or show stale progress.
const MemoActivityRow = memo(ActivityRowBase)

function ConnectedActivityRow(props: Props) {
  const { settings } = useWallet()
  return <MemoActivityRow {...props} currency={settings?.currency || 'BSV'} />
}

/** Preserve the existing package API for hosts that omit currency; the home
 * screen supplies it so background wallet updates cannot invalidate each row. */
export default function ActivityRow(props: Props) {
  return props.currency === undefined
    ? <ConnectedActivityRow {...props} />
    : <MemoActivityRow {...props} currency={props.currency} />
}
