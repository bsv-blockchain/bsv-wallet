/**
 * Pay → anyone.
 *
 * One recipient field decides the rail: a base58check address goes out as a
 * plain P2PKH payment; an identity key, peerpay link or search hit goes out as
 * a PeerPay token dropped in the recipient's message box; a nearby-session
 * code is handed up to the Pay screen, which swaps this form for NearbyFlow.
 * Nothing here is chosen by the user except the recipient and the amount.
 *
 * The form recomposes by what the field resolved to: a note field exists
 * only for handles (an address has nowhere to carry one), and the "they are
 * not notified" consequence is shown only for addresses, where it is
 * load-bearing — a user who pastes an address expecting messaging-style
 * delivery has effectively posted cash.
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
import { useMessageBoxConfig } from './MessageBoxConfig'
import { useRecipientInput, type RecipientTarget } from './useRecipientInput'
import {
  useTheme,
  spacing,
  typography,
  radii,
  hitTargets,
  useWalletManagers,
  CONSEQUENCE_KEYS,
  NO_MESSAGE_BOX,
  cancelOutboxPayment,
  isMessageBoxNetworkError,
  makePeerPayClient,
  retryDelivery,
  sendViaHandle,
  sendToAddress,
  getOutboxEntries,
  pruneExpiredSent,
  unsentEntries,
  type OutboxEntry,
  type Session,
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

export interface UniversalSendProps {
  /** A recipient known before the form opened: a peerpay deep link or `?identityKey=`. */
  initialTarget?: Extract<RecipientTarget, { kind: 'handle' }>
  /** Prefilled amount in satoshis from a peerpay link or `?sats=`. */
  initialSats?: number
  /** Error text from a malformed peerpay link, shown as a banner. */
  initialNotice?: string | null
  /** Open the scanner as soon as the form mounts (deep link `cell=pay-nearby`). */
  openScannerOnMount?: boolean
  /** A nearby-session code was scanned. The Pay screen swaps this form for NearbyFlow. */
  onNearbySession: (session: Session) => void
  /** Where the post-payment overlay sends the user. Defaults to `/`. */
  dismissTo?: string
}

function UniversalSend({
  initialTarget,
  initialSats,
  initialNotice,
  openScannerOnMount = false,
  onNearbySession,
  dismissTo = '/'
}: UniversalSendProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const StatusBar = loadStatusBar()
  const { managers, adminOriginator, storage } = useWalletManagers()
  const wallet = managers?.permissionsManager || null

  // Read-only here: the server is configured in Settings › Advanced.
  const { messageBoxUrl } = useMessageBoxConfig(t)
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

  const onPeerPayAmount = useCallback((sats: number) => setSendAmount(String(sats)), [])
  const onPeerPayError = useCallback((message: string) => setNotice({ type: 'error', message }), [])
  const recipient = useRecipientInput({
    wallet,
    adminOriginator,
    initialTarget,
    onPeerPayAmount,
    onPeerPayError,
    onNearbySession
  })
  const target = recipient.target

  // A second deep link while mounted re-adopts the recipient (useRecipientInput);
  // the amount and the notice it carried must follow, or Pay sends the OLD
  // figure to the NEW person.
  useEffect(() => {
    setSendAmount(initialSats && initialSats > 0 ? String(initialSats) : '')
  }, [initialSats])
  useEffect(() => {
    setNotice(initialNotice ? { type: 'error', message: initialNotice } : null)
  }, [initialNotice])

  useEffect(() => {
    if (openScannerOnMount) recipient.openScanner()
    // Mount-only by design: re-opening on every render would trap the user in the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const peerPayClient = useMemo(
    () => makePeerPayClient({ wallet: wallet as never, messageBoxUrl, originator: adminOriginator }),
    [messageBoxUrl, wallet, adminOriginator]
  )

  const loadOutbox = useCallback(async () => {
    if (!storage) return
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

  const flashResult = useCallback((result: { type: 'success' | 'error'; message: string }) => {
    setSendResult(result)
    setTimeout(() => setSendResult(null), 5000)
  }, [])

  const handleWalletCheck = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!userFacingPayError(error).offerWalletCheck) return false
      const choice = await promptCheckWallet(t)
      if (choice === 'check_wallet') loadExpoRouter().router.push('/wallet-check' as any)
      return true
    },
    [t]
  )

  const sendHandle = useCallback(
    async (to: Extract<RecipientTarget, { kind: 'handle' }>, sats: number) => {
      const client = peerPayClient
      if (!client) throw new Error(t('message_box_off_hint'))
      if (!storage || !wallet) throw new Error(t('wallet_not_ready'))
      const { satoshis: paidSats } = await sendViaHandle({
        wallet: wallet as any,
        adminOriginator,
        client,
        storage,
        recipient: to.identityKey,
        recipientHost: to.messageBoxUrl,
        satoshis: sats,
        messageBoxUrl,
        note,
        recipientName: recipient.selectedIdentity?.name
      })
      await loadOutbox()
      // The overlay stages its own haptic (inside Celebration) and tone; firing
      // haptics.success() here would double the beat. Only a human-readable
      // name goes on the success screen — a raw identity key is noise there.
      setSent({ amount: paidSats, recipient: recipient.selectedIdentity?.name })
    },
    [peerPayClient, storage, wallet, adminOriginator, messageBoxUrl, note, recipient.selectedIdentity, loadOutbox, t]
  )

  const sendAddress = useCallback(
    async (to: Extract<RecipientTarget, { kind: 'address' }>, sats: number) => {
      if (!wallet) throw new Error(t('wallet_not_ready'))
      const { paidSatoshis } = await sendToAddress({
        wallet: wallet as any,
        adminOriginator,
        address: to.address,
        satoshis: sats
      })
      setSent({ amount: paidSatoshis, recipient: to.address })
    },
    [wallet, adminOriginator, t]
  )

  const handleSend = useCallback(async () => {
    if (!target) return
    // Guard before any side effect: a wallet that is not ready must leave the
    // form exactly as typed, with a banner, not a cleared field and silence.
    if (!wallet || !storage) {
      flashResult({ type: 'error', message: t('wallet_not_ready') })
      return
    }
    const sats = Math.round(Number(sendAmount))
    if (!Number.isFinite(sats) || sats <= 0) {
      flashResult({ type: 'error', message: t('enter_valid_amount') })
      return
    }
    haptics.confirm()
    setIsSending(true)
    try {
      if (target.kind === 'handle') await sendHandle(target, sats)
      else await sendAddress(target, sats)
      setSendAmount('')
      setNote('')
      recipient.clearRecipient()
    } catch (error: any) {
      if (await handleWalletCheck(error)) return
      const message =
        error instanceof RangeError
          ? t('enter_valid_amount')
          : isMessageBoxNetworkError(error)
            ? t('message_box_unreachable')
            : error?.message || t('unknown_error')
      flashResult({ type: 'error', message })
      // A failed handle send leaves its entry 'unsent' and offered for retry below.
      if (target.kind === 'handle') await loadOutbox()
    } finally {
      setIsSending(false)
    }
  }, [
    target,
    sendAmount,
    sendHandle,
    sendAddress,
    recipient,
    handleWalletCheck,
    flashResult,
    loadOutbox,
    t,
    wallet,
    storage
  ])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      // `peerPayClient` is built from the CURRENT setting, so it wins: the
      // configured host may have changed since this entry was minted, and the
      // client re-resolves the recipient's advertised inbox on every send
      // anyway. The entry's own host is the last resort, for when the user has
      // since opted out of a server entirely. When the entry carries a
      // `recipientHost`, `retryDelivery` passes it as the override regardless
      // of which client is used.
      const client =
        peerPayClient ??
        makePeerPayClient({ wallet: wallet as never, messageBoxUrl: entry.messageBoxUrl, originator: adminOriginator })
      if (!client || !storage) {
        showToast(t('message_box_off_hint'), { type: 'error' })
        return
      }
      setRetryingId(entry.id)
      try {
        await retryDelivery({ wallet: wallet as any, adminOriginator, client, storage, entry })
        setSent({ amount: entry.token.amount })
      } catch (e: any) {
        if (await handleWalletCheck(e)) return
        const reason = isMessageBoxNetworkError(e) ? t('message_box_unreachable') : e?.message || t('unknown_error')
        showToast(`${t('retry_failed')}: ${reason}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, wallet, adminOriginator, t, handleWalletCheck]
  )

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
          showToast(t('message_box_off_hint'), { type: 'error' })
          return
        }
        setRetryingId(entry.id)
        try {
          await cancelOutboxPayment({ wallet: wallet as any, adminOriginator, storage, entry, client, mode: 'abandon' })
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
        await cancelOutboxPayment({ wallet: wallet as any, adminOriginator, storage, entry, mode: 'undelivered' })
      } catch (e: any) {
        showToast(e?.message || t('unknown_error'), { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [storage, wallet, adminOriginator, peerPayClient, handleRetry, loadOutbox, t]
  )

  const amountOk = Number(sendAmount) > 0
  const isHandle = target?.kind === 'handle'
  const isAddress = target?.kind === 'address'
  // A stuck handle payment blocks new HANDLE sends: every attempt while the box
  // is unreachable would mint another noSend action and another stuck entry.
  // Address sends never touch the box, so they are not held hostage by it.
  const handleBlockedByOutbox = isHandle && outbox.length > 0
  const handleFormValid = isHandle && amountOk && !isSending && isConfigured
  const canSend = isAddress ? amountOk && !isSending : handleFormValid && !handleBlockedByOutbox

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}
      {recipient.searchError && (
        <ResultBanner
          result={{ type: 'error', message: t('identity_search_unavailable') }}
          onDismiss={recipient.clearSearchError}
          colors={colors}
        />
      )}

      <PayField labelKey="recipient">
        <RecipientField
          selectedIdentity={recipient.selectedIdentity}
          inputText={recipient.inputText}
          target={recipient.target}
          inlineError={recipient.inlineError}
          isSearching={recipient.isSearching}
          searchResults={recipient.searchResults}
          colors={colors}
          t={t}
          onChangeText={recipient.onChangeText}
          onSelectIdentity={recipient.selectIdentity}
          onClear={recipient.clearRecipient}
          onOpenScanner={recipient.openScanner}
        />
      </PayField>

      <PayAmountField value={sendAmount} onChangeText={setSendAmount} />

      {isHandle && (
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
      )}

      {/* Load-bearing for an address: this rail cannot notify the payee. Nothing for a handle. */}
      {isAddress && <ConsequenceNote textKey={CONSEQUENCE_KEYS.address} />}

      {isHandle && !isConfigured && (
        <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('message_box_off_hint')}</Text>
      )}
      {handleFormValid && handleBlockedByOutbox && (
        <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('finish_or_cancel_outgoing')}</Text>
      )}

      <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} />

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

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
        visible={recipient.scannerVisible}
        animationType="slide"
        onRequestClose={() => recipient.setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={recipient.onScan}
          onClose={() => recipient.setScannerVisible(false)}
          hintText={t('scan_recipient_hint')}
        />
      </Modal>

      {sent && (
        <PaymentSuccessOverlay
          direction="sent"
          amount={sent.amount}
          recipientName={sent.recipient}
          onDismiss={() => setSent(null)}
          dismissTo={dismissTo}
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

// Wallet status updates in the parent do not change this form's inputs.
export default memo(UniversalSend)
