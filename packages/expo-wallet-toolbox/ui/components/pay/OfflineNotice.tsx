/**
 * Three things the user must be told, in one place.
 *
 * While offline: which rails still work and how many payments are waiting to be
 * broadcast. While ONLINE with a queue that has not drained: that those payments
 * still have not reached the network. After a rejection: which payment the
 * network refused and who handed it over — that identity key is the only
 * recourse the user has, so the row persists rather than toasting away.
 *
 * The online-with-a-queue case is not cosmetic. `processOfflineActions` can stall
 * permanently — behind a foreign ancestor no service will accept, or on a row
 * whose request has gone — and it reports that only as `stalledOn`, whose one
 * consumer writes it into the monitor's log string
 * (`utils/monitor/TaskSendOffline.ts`). Nothing else in the system records it. If
 * this component went blank the moment signal returned, a user would watch a
 * stuck payment behave exactly like a settled one.
 *
 * A rejection can also be the user's OWN outbound payment — a held send can be
 * poisoned same as a held receive (see app/pay.tsx's role split). That gets a
 * separate, unattributed notice: there is no counterparty to name for a
 * transaction the user sent themselves, and folding it into the "who handed
 * you this" copy would misreport the user's own failure as someone else's
 * fraud against them.
 *
 * It never claims settlement. A payment nobody has broadcast can still be
 * double-spent by the payer once they reconnect; no header check closes that,
 * so the copy says "not yet broadcast", never "received". Nor does it ever
 * claim delivery for a payment the user sent — only that the network refused
 * it.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, radii, spacing, typography, hitTargets, type OfflineActionRow } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

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

export function offlineActionDetails(row: OfflineActionRow): string {
  const lines = [`txid: ${row.txid}`]
  if (row.senderIdentityKey) lines.push(`sender: ${row.senderIdentityKey}`)
  if (row.receivedVia) lines.push(`via: ${row.receivedVia}`)
  if (row.rejectedReason) lines.push(`reason: ${row.rejectedReason}`)
  if (row.created_at) lines.push(`when: ${row.created_at}`)
  return lines.join('\n')
}

export interface OfflineNoticeProps {
  online: boolean
  queued: number
  rejected: OfflineActionRow[]
  /**
   * A payer's own held payment can be rejected too (the same release plan
   * poisons rows regardless of role — see app/pay.tsx's queue effect), but it
   * carries no sender to name: there is no counterparty to blame for a
   * transaction the user sent themselves. Rendered as its own, unattributed
   * notice rather than folded into `rejected`'s "who handed you this" copy.
   */
  sentRejected?: OfflineActionRow[]
  /** Fires TaskSendOffline.requestNow via the caller. Rendered only when online with a queue. */
  onSendNow?: () => void
  /** TaskSendOffline.lastStall — set when retrying alone will not drain the queue. */
  stalled?: string
  /** Queued/posting rows the user sent. Rows with a framePayload get a re-show affordance. */
  queuedSent?: OfflineActionRow[]
  onShowCode?: (row: OfflineActionRow) => void
  /** Re-send `resend_request` for a rejected received payment. */
  onRequestAgain?: (row: OfflineActionRow) => void
  /** Prefill `/pay` with the rejected sent amount. */
  onSendAgain?: (row: OfflineActionRow) => void
  onCopyDetails?: (row: OfflineActionRow) => void
  /** Archive a rejected row as `acknowledged`. Not destructive. */
  onDismiss?: (row: OfflineActionRow) => void
  /** Tighter padding when mounted above the home activity list. */
  compact?: boolean
}

export default function OfflineNotice({
  online,
  queued,
  rejected,
  sentRejected = [],
  onSendNow,
  stalled,
  queuedSent,
  onShowCode,
  onRequestAgain,
  onSendAgain,
  onCopyDetails,
  onDismiss,
  compact = false
}: OfflineNoticeProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  if (online && queued === 0 && rejected.length === 0 && sentRejected.length === 0 && (queuedSent ?? []).length === 0)
    return null

  const actionBtn = (label: string, onPress?: () => void) => (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.actionBtn}
    >
      <Text style={[styles.actionBtnLabel, { color: colors.info }]}>{label}</Text>
    </PressableScale>
  )

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {!online && (
        <View style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
          <Ionicons name="cloud-offline-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {queued > 0 ? t('pay_offline_queued', { count: queued }) : t('pay_offline_body')}
            </Text>
          </View>
        </View>
      )}
      {/* Online and still queued. The offline card above already carries the
          count, so this is the case it cannot cover: signal is back and the
          queue has not drained, which is either a run that has not happened yet
          or one that never will. Same honesty rule as everywhere else in this
          feature — waiting to be broadcast, never settled. */}
      {online && queued > 0 && (
        <View style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
          <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_pending_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {t('pay_offline_pending_body', { count: queued })}
            </Text>
            {!!stalled && (
              <Text style={[styles.body, { color: colors.warning }]}>
                {t('pay_offline_stalled_body', { detail: stalled })}
              </Text>
            )}
            {onSendNow && (
              <Text accessibilityRole="button" onPress={onSendNow} style={[styles.action, { color: colors.info }]}>
                {t('pay_offline_send_now')}
              </Text>
            )}
          </View>
        </View>
      )}
      {rejected.map(r => (
        <View
          key={r.txid}
          style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
        >
          <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_rejected_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {t('pay_offline_rejected_body', {
                sender: r.senderIdentityKey ? `${r.senderIdentityKey.slice(0, 8)}…` : t('pay_offline_unknown_sender'),
                via: r.receivedVia ?? t('pay_offline_unknown_via'),
                when: r.created_at.slice(0, 10)
              })}
            </Text>
            <View style={styles.actions}>
              {!!r.senderIdentityKey && actionBtn(t('request_again'), () => onRequestAgain?.(r))}
              {actionBtn(t('copy_details'), () => onCopyDetails?.(r))}
              {actionBtn(t('cancel'), () => onDismiss?.(r))}
            </View>
          </View>
        </View>
      ))}
      {sentRejected.map(r => (
        <View
          key={r.txid}
          style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
        >
          <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_sent_rejected_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {t('pay_offline_sent_rejected_body', { when: r.created_at.slice(0, 10) })}
            </Text>
            <View style={styles.actions}>
              {actionBtn(t('send_again'), () => onSendAgain?.(r))}
              {actionBtn(t('copy_details'), () => onCopyDetails?.(r))}
              {actionBtn(t('cancel'), () => onDismiss?.(r))}
            </View>
          </View>
        </View>
      ))}
      {(queuedSent ?? [])
        .filter(r => r.framePayload)
        .map(r => (
          <View
            key={`code-${r.txid}`}
            style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
          >
            <Ionicons name="qr-code-outline" size={18} color={colors.textSecondary} />
            <View style={styles.text}>
              <Text style={[styles.body, { color: colors.textSecondary }]}>{r.created_at.slice(0, 10)}</Text>
              <Text
                accessibilityRole="button"
                onPress={() => onShowCode?.(r)}
                style={[styles.action, { color: colors.info }]}
              >
                {t('pay_offline_show_code')}
              </Text>
            </View>
          </View>
        ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // No horizontal padding: this mounts inside the grid, which already supplies
  // spacing.lg on both sides. Adding it here would double-indent the cards
  // relative to the cell rows below them.
  wrap: { paddingBottom: spacing.md, gap: spacing.sm },
  wrapCompact: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.xs
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: { flex: 1, gap: 2 },
  title: { ...typography.subhead, fontWeight: '600' },
  body: { ...typography.footnote },
  action: { ...typography.subhead, fontWeight: '600', marginTop: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
  actionBtn: {
    minHeight: hitTargets.minimum,
    minWidth: hitTargets.minimum,
    justifyContent: 'center',
    paddingRight: spacing.md
  },
  actionBtnLabel: { ...typography.subhead, fontWeight: '600' }
})
