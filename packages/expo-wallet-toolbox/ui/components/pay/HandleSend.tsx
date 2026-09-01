/**
 * Pay → someone with this app.
 *
 * The recipient is a handle (an identity key, reached by search, scan or deep
 * link) and delivery is asynchronous: the token is dropped in their MessageBox
 * and lands when their wallet next checks. That is exactly what the consequence
 * line under the button says, and why it says it before the send rather than
 * after.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import QRScanner from '../QRScanner'
import AmountDisplay from '../wallet/AmountDisplay'
import { showAlert } from '../ui/AlertCard'
import { showChoiceSheet } from '../ui/ChoiceSheet'
import { promptCheckWallet } from '../../screens/WalletCheckScreen'
import { userFacingPayError } from '../../../core/pay/userError'
import PressableScale from '../ui/PressableScale'
import { showToast } from '../ui/Toast'
import { ConsequenceNote, PayAmountField, PayCta, PayField } from './PayForm'
import PaymentSuccessOverlay from './PaymentSuccessOverlay'
import ResultBanner from './ResultBanner'
import RecipientField from './RecipientField'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from './MessageBoxConfig'
import { useIdentitySearch } from './useIdentitySearch'
import {
  useTheme,
  spacing,
  typography,
  radii,
  hitTargets,
  useWallet,
  CONSEQUENCE_KEYS,
  NO_MESSAGE_BOX,
  cancelOutboxPayment,
  isMessageBoxNetworkError,
  makePeerPayClient,
  retryDelivery,
  sendViaHandle,
  getOutboxEntries,
  pruneExpiredSent,
  unsentEntries,
  type OutboxEntry,
  haptics,
  listPendingResendRequests
} from '@bsv/expo-wallet-toolbox'

/**
 * expo-status-bar's package.json `main` points straight at its raw
 * TypeScript source (no compiled build output ships), and the unscoped,
 * hyphenated package name is not in this repo's Jest transformIgnorePatterns
 * allow-list, so a static top-level import fails to parse for any consumer
 * of the `ui` package barrel. Loaded lazily, only when actually rendering,
 * same pattern as this package's other native/ESM-boundary fixes.
 */
type StatusBarComponent = typeof import('expo-status-bar').StatusBar
let statusBarComponent: StatusBarComponent | undefined
function loadStatusBar(): StatusBarComponent {
  if (!statusBarComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    statusBarComponent = require('expo-status-bar').StatusBar as StatusBarComponent
  }
  return statusBarComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

// ── Outgoing Section ─────────────────────────────────────────────────────────

interface OutgoingSectionProps {
  readonly entries: OutboxEntry[]
  readonly retryingId: string | null
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRetry: (entry: OutboxEntry) => void
  readonly onCancel: (entry: OutboxEntry) => void
}

function OutgoingSection({ entries, retryingId, colors, t, onRetry, onCancel }: OutgoingSectionProps) {
  if (entries.length === 0) return null

  return (
    <PayField labelKey="outgoing_payments">
      <View style={[styles.outgoingCard, { backgroundColor: colors.background, borderColor: colors.separator }]}>
        {entries.map((entry, idx) => {
          const isRetrying = retryingId === entry.id
          const isLast = idx === entries.length - 1
          // Unsent rows: delivery and/or broadcast still outstanding.
          const accentColor = colors.warning
          const truncated = `${entry.recipient.slice(0, 8)}…${entry.recipient.slice(-4)}`
          return (
            <View
              key={entry.id}
              style={[
                styles.outgoingRow,
                { borderLeftColor: accentColor },
                !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
              ]}
            >
              {/* Top row: recipient key + amount */}
              <View style={styles.outgoingInfo}>
                <View style={styles.outgoingTopRow}>
                  <Text style={[styles.outgoingRecipient, { color: colors.textPrimary }]} numberOfLines={1}>
                    {truncated}
                  </Text>
                  <Text style={[styles.outgoingAmount, { color: accentColor }]}>
                    <AmountDisplay>{entry.token.amount}</AmountDisplay>
                  </Text>
                </View>

                {/* Status / error text */}
                <Text style={[styles.outgoingStatusText, { color: colors.textSecondary }]} numberOfLines={2}>
                  {entry.lastError
                    ? isMessageBoxNetworkError(entry.lastError)
                      ? t('message_box_unreachable')
                      : entry.lastError
                    : t('payment_not_delivered')}
                </Text>

                {/* Action buttons — full-width row, easy tap targets */}
                <View style={[styles.outgoingButtons, { borderTopColor: colors.separator }]}>
                  <PressableScale
                    onPress={() => onCancel(entry)}
                    disabled={isRetrying}
                    haptic="tap"
                    style={[styles.outgoingDismissButton, { borderRightColor: colors.separator }]}
                  >
                    <Text style={[styles.outgoingDismissText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => onRetry(entry)}
                    disabled={isRetrying}
                    haptic="tap"
                    style={styles.outgoingRetryButton}
                  >
                    {isRetrying ? (
                      <View style={styles.outgoingRetryBusy}>
                        <ActivityIndicator size="small" color={colors.accent} />
                        <Text style={[styles.outgoingRetryText, { color: colors.accent }]}>{t('resending')}</Text>
                      </View>
                    ) : (
                      <Text style={[styles.outgoingRetryText, { color: colors.accent }]}>{t('retry')}</Text>
                    )}
                  </PressableScale>
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </PayField>
  )
}

export interface HandleSendProps {
  /** Prefilled recipient from a deep link or a scan (identity key hex). */
  initialIdentityKey?: string
  /** Prefilled amount in satoshis from a peerpay link. */
  initialSats?: number
  /** Error text from a malformed peerpay link, shown as a banner. */
  initialNotice?: string | null
}

export default function HandleSend({ initialIdentityKey, initialSats, initialNotice }: HandleSendProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const StatusBar = loadStatusBar()
  const { managers, adminOriginator, storage } = useWallet()
  const wallet = managers?.permissionsManager || null

  const config = useMessageBoxConfig(t)
  const { messageBoxUrl, setShowConfig } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [sendAmount, setSendAmount] = useState(initialSats && initialSats > 0 ? String(initialSats) : '')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  /** The success moment, held until acknowledged — same screen as every rail. */
  const [sent, setSent] = useState<{ amount: number; recipient?: string } | null>(null)
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const search = useIdentitySearch(
    wallet as any,
    adminOriginator,
    initialIdentityKey,
    sats => setSendAmount(String(sats)),
    message => setNotice({ type: 'error', message })
  )

  const peerPayClient = useMemo(
    () => makePeerPayClient({ wallet: wallet as never, messageBoxUrl, originator: adminOriginator }),
    [messageBoxUrl, wallet, adminOriginator]
  )

  const loadOutbox = useCallback(async () => {
    if (!storage) return
    // Sent entries are kept as the sender-side token copy for resend, then
    // pruned after 30 days. Only unsent entries surface in Retry/Cancel.
    await pruneExpiredSent(storage)
    setOutbox(unsentEntries(await getOutboxEntries(storage)))
  }, [storage])

  useEffect(() => {
    void loadOutbox()
  }, [loadOutbox])

  const pollResendRequests = useCallback(async () => {
    const client = peerPayClient
    if (!client || !storage) return
    try {
      await listPendingResendRequests({ client, storage })
    } catch {
      // Home owns the unanswered-resend banner; a failed poll here is retryable.
    }
  }, [peerPayClient, storage])

  useEffect(() => {
    void pollResendRequests()
  }, [pollResendRequests])

  const handleSend = useCallback(async () => {
    const client = peerPayClient
    if (!client || !search.recipientKey || !storage) return
    const sats = Math.round(Number(sendAmount))
    if (!Number.isFinite(sats) || sats <= 0) {
      setSendResult({ type: 'error', message: t('enter_valid_amount') })
      setTimeout(() => setSendResult(null), 5000)
      return
    }
    haptics.confirm()
    setIsSending(true)
    try {
      const { satoshis: paidSats } = await sendViaHandle({
        wallet: wallet as any,
        adminOriginator,
        client,
        storage,
        recipient: search.recipientKey,
        satoshis: sats,
        messageBoxUrl,
        note,
        recipientName: search.selectedIdentity?.name
      })
      await loadOutbox()
      // The overlay stages its own haptic (inside Celebration) and tone; firing
      // haptics.success() here would double the beat. Only a human-readable
      // name goes on the success screen — a raw identity key is noise there.
      setSent({
        amount: paidSats,
        recipient: search.selectedIdentity?.name
      })
      setSendAmount('')
      setNote('')
      search.clearRecipient()
    } catch (error: any) {
      if (userFacingPayError(error).offerWalletCheck) {
        const choice = await promptCheckWallet(t)
        if (choice === 'check_wallet') loadExpoRouter().router.push('/wallet-check' as any)
        return
      }
      // An unreachable message box is a configuration problem, not a payment
      // one — point at the fix rather than echoing the raw fetch error.
      const message =
        error instanceof RangeError
          ? t('enter_valid_amount')
          : isMessageBoxNetworkError(error)
            ? t('message_box_unreachable')
            : error?.message || t('unknown_error')
      setSendResult({ type: 'error', message })
      // The outbox entry stays 'unsent' and is offered for retry below.
      await loadOutbox()
    } finally {
      setIsSending(false)
      setTimeout(() => setSendResult(null), 5000)
    }
  }, [peerPayClient, search, sendAmount, note, storage, messageBoxUrl, loadOutbox, wallet, adminOriginator, t])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      // `peerPayClient` is built from the CURRENT setting, so it wins: the
      // configured host may have changed since this entry was minted, and the
      // client re-resolves the recipient's advertised inbox on every send
      // anyway. The entry's own host is the last resort, for when the user has
      // since opted out of a server entirely.
      const client =
        peerPayClient ??
        makePeerPayClient({
          wallet: wallet as never,
          messageBoxUrl: entry.messageBoxUrl,
          originator: adminOriginator
        })
      if (!client || !storage) {
        setShowConfig(true)
        showToast(t('message_box_unreachable'), { type: 'error' })
        return
      }
      setRetryingId(entry.id)
      try {
        await retryDelivery({ wallet: wallet as any, adminOriginator, client, storage, entry })
        // A retried payment that lands gets the same success moment as one
        // that worked first time — held until Done, then back to the wallet.
        setSent({ amount: entry.token.amount })
      } catch (e: any) {
        if (userFacingPayError(e).offerWalletCheck) {
          const choice = await promptCheckWallet(t)
          if (choice === 'check_wallet') loadExpoRouter().router.push('/wallet-check' as any)
          return
        }
        const reason = isMessageBoxNetworkError(e)
          ? t('message_box_unreachable')
          : e?.message || t('unknown_error')
        showToast(`${t('retry_failed')}: ${reason}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, wallet, adminOriginator, t, setShowConfig]
  )

  /**
   * Cancel a stuck payment. Undelivered: one confirm, then abort. Delivered or
   * delivering: Abandon (payment_cancelled) or Finish (retry) — the sheet is
   * the confirmation.
   */
  const handleCancel = useCallback(
    async (entry: OutboxEntry) => {
      if (!storage || !wallet) return
      const deliveredOrUncertain = entry.delivered === true || entry.delivering === true
      if (deliveredOrUncertain) {
        const key = await showChoiceSheet({
          title: t('cancel_this_payment'),
          options: [
            { key: 'abandon', label: t('abandon_payment'), destructive: true },
            { key: 'finish', label: t('finish_payment') }
          ],
          cancelLabel: t('cancel')
        })
        if (key === 'finish') {
          await handleRetry(entry)
          return
        }
        if (key !== 'abandon') return
        const client = peerPayClient
        if (!client) {
          setShowConfig(true)
          showToast(t('message_box_unreachable'), { type: 'error' })
          return
        }
        setRetryingId(entry.id)
        try {
          await cancelOutboxPayment({
            wallet: wallet as any,
            adminOriginator,
            storage,
            entry,
            client,
            mode: 'abandon'
          })
        } catch (e: any) {
          const reason = isMessageBoxNetworkError(e) ? t('message_box_unreachable') : e?.message || t('unknown_error')
          showToast(reason, { type: 'error' })
        } finally {
          setRetryingId(null)
          await loadOutbox()
        }
        return
      }
      const choice = await showAlert({
        title: t('cancel_this_payment'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'cancel' },
          { text: t('cancel_payment'), style: 'destructive', key: 'cancel_payment' }
        ]
      })
      if (choice !== 'cancel_payment') return
      setRetryingId(entry.id)
      try {
        await cancelOutboxPayment({
          wallet: wallet as any,
          adminOriginator,
          storage,
          entry,
          mode: 'undelivered'
        })
      } catch (e: any) {
        showToast(e?.message || t('unknown_error'), { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [storage, wallet, adminOriginator, peerPayClient, handleRetry, loadOutbox, t, setShowConfig]
  )

  /**
   * A stuck payment blocks new sends: every attempt while the message box is
   * unreachable would mint another noSend action and another stuck entry, so
   * the only ways forward are Retry and Cancel on what is already queued.
   */
  const formOtherwiseValid = search.recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured
  const canSend = formOtherwiseValid && outbox.length === 0

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Config lives behind the same gear the old screen used, not on the main path. */}
      <MessageBoxBar
        url={config.messageBoxUrl}
        open={config.showConfig}
        onToggle={() =>
          // A no-server sentinel keeps the panel pinned open: there is nothing to
          // collapse back to, and closing it would hide the only way to fix it.
          config.setShowConfig(v => (config.messageBoxUrl === NO_MESSAGE_BOX ? true : !v))
        }
        colors={colors}
        t={t}
      />
      {config.showConfig && (
        <ConfigPanel
          urlInput={config.urlInput}
          isSaving={config.isSaving}
          colors={colors}
          t={t}
          onChangeUrl={config.setUrlInput}
          onSave={() => {
            void config.handleSave(config.urlInput)
          }}
          onReset={config.handleReset}
          onNone={config.handleNone}
        />
      )}
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}
      {search.searchError && (
        <ResultBanner
          result={{ type: 'error', message: t('identity_search_unavailable') }}
          onDismiss={search.clearSearchError}
          colors={colors}
        />
      )}

      <PayField labelKey="recipient">
        <RecipientField
          selectedIdentity={search.selectedIdentity}
          searchQuery={search.searchQuery}
          recipientKey={search.recipientKey}
          isSearching={search.isSearching}
          searchResults={search.searchResults}
          colors={colors}
          t={t}
          onSearchChange={search.handleSearchChange}
          onSelectIdentity={search.handleSelectIdentity}
          onClear={search.clearRecipient}
          onOpenScanner={search.openScanner}
        />
      </PayField>

      <PayAmountField value={sendAmount} onChangeText={setSendAmount} />

      <PayField labelKey="note">
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={t('note_placeholder')}
          placeholderTextColor={colors.textQuaternary}
          maxLength={280}
          style={[
            styles.noteInput,
            { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator, color: colors.textPrimary }
          ]}
        />
      </PayField>

      {/* The consequence, before the button — not after. */}
      <ConsequenceNote textKey={CONSEQUENCE_KEYS.handle} />

      {formOtherwiseValid && outbox.length > 0 && (
        <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('finish_or_cancel_outgoing')}</Text>
      )}

      <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} />

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

      {/* Outgoing: unsent tokens offered for manual retry, exactly as before. */}
      {outbox.length > 0 && (
        <OutgoingSection
          entries={outbox}
          retryingId={retryingId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onCancel={handleCancel}
        />
      )}

      <Modal
        visible={search.scannerVisible}
        animationType="slide"
        onRequestClose={() => search.setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={search.handleQRScanned}
          onClose={() => search.setScannerVisible(false)}
          hintText={t('scan_identity_key_hint')}
        />
      </Modal>

      {sent && (
        <PaymentSuccessOverlay
          direction="sent"
          amount={sent.amount}
          recipientName={sent.recipient}
          onDismiss={() => setSent(null)}
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Field group
  fieldGroup: {
    marginBottom: spacing.lg
  },

  // Consequence line + call to action
  consequence: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: {
    ...typography.subhead,
    fontWeight: '600'
  },

  // Outgoing section
  outgoingCard: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing.lg
  },
  outgoingRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 3
  },
  outgoingInfo: {
    gap: 6
  },
  outgoingTopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  outgoingRecipient: {
    ...typography.footnote,
    fontWeight: '500',
    fontFamily: 'monospace',
    flex: 1
  },
  outgoingAmount: {
    ...typography.subhead,
    fontWeight: '700',
    flexShrink: 0
  },
  outgoingStatusText: {
    ...typography.caption1,
    marginBottom: spacing.sm
  },
  outgoingButtons: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: -spacing.lg,
    marginBottom: -spacing.md
  },
  outgoingDismissButton: {
    flex: 1,
    minHeight: hitTargets.minimum,
    minWidth: hitTargets.minimum,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth
  },
  outgoingRetryButton: {
    flex: 1,
    minHeight: hitTargets.minimum,
    minWidth: hitTargets.minimum,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center'
  },
  outgoingRetryBusy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  outgoingRetryText: {
    ...typography.subhead,
    fontWeight: '600'
  },
  outgoingDismissText: {
    ...typography.subhead
  },

  noteInput: {
    ...typography.body,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  }
})
