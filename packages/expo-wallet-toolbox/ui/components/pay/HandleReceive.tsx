/**
 * Get paid → someone with this app.
 *
 * Your handle in three forms, because the counterparty's situation decides
 * which one works: a QR to scan across a table, a copyable key to paste, and a
 * peerpay: link to send through any messaging app. All three carry the same
 * identity key — the link is the one the app can route itself, via
 * +native-intent, straight back into Pay → handle.
 *
 * Below it: nothing, when all is well. Arriving payments are credited the moment
 * this screen sees them — accepting was never a decision anyone could act on,
 * since the money is already theirs and refusing only leaves it in the box. The
 * list below appears only for payments the wallet could NOT credit, and exists
 * so those can be retried or, when they are structurally broken, given up on.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'
import { useTranslation } from 'react-i18next'
import { PeerPayClient, type IncomingPayment } from '@bsv/message-box-client'
import { type DisplayableIdentity } from '@bsv/sdk'

import ResultBanner from './ResultBanner'
import ReceivedOverlay from './PaymentSuccessOverlay'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from './MessageBoxConfig'
import AmountDisplay from '../wallet/AmountDisplay'
import PressableScale from '../ui/PressableScale'
import { showAlert } from '../ui/AlertCard'
import { showToast } from '../ui/Toast'
import { makeIdentityClient, resolveIdentity } from '../../resolveIdentity'
import { makeBeefRepair } from '../../../core/pay/beefRepair'
import { wocConfigFor } from '../../../core/pay/rails/address'
import { makeCreditClassifier } from '../../../core/pay/creditErrors'
import { satoshisFromToken } from '../../../core/pay/tokenAmount'
import { userFacingPayError } from '../../../core/pay/userError'
import { creditInboxOnce, INBOX_DESCRIPTION, type CreditInboxResult } from '../../../core/pay/creditInbox'
import { TaskCreditInbox } from '../../../core/monitor/TaskCreditInbox'
import { useOnline } from '../../hooks/useOnline'
import { type DamagedInboxMessage } from '../../../core/pay/damagedInbox'
import { getOnline } from '../../../core/net/online'
import { saveInboxAttempts } from '../../../core/peerpay/inboxAttempts'
import {
  useTheme,
  radii,
  spacing,
  typography,
  useWallet,
  NO_MESSAGE_BOX,
  acceptWithRetry,
  discardIncoming,
  internalizeIncoming,
  needsAttention,
  peerPayLinkFor,
  type InboxAttempt
} from '@bsv/expo-wallet-toolbox'

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
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's and WalletHomeScreen.tsx's lazy
 * expo-router load. `useFocusEffect` is a hook, but calling it via
 * `loadExpoRouter().useFocusEffect(...)` is equivalent to calling it directly
 * — the module is cached after the first call, so it is the exact same
 * function reference on every render, which is what the rules of hooks
 * actually require (a stable, unconditional call per render).
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

/**
 * @react-native-clipboard/clipboard reaches for its native TurboModule at
 * import time (`TurboModuleRegistry.getEnforcing`), which throws under Jest
 * (no native binary registered there) even though the module itself
 * transforms fine. Required lazily, only when a handler actually copies
 * something, so importing the `ui` barrel never touches the native module.
 * Same pattern as WalletHomeScreen.tsx's lazy clipboard load.
 */
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

/**
 * react-native-qrcode-svg ships an untransformed ESM build that Jest cannot
 * parse when eagerly pulled in via the `ui` package barrel, even for a
 * consumer that never renders one. Loaded lazily, only when actually
 * rendering, same pattern as this package's other native/ESM-boundary fixes.
 * `mod?.default ?? mod` mirrors Babel's default-interop rather than a plain
 * `.default` access, since this repo's test mock for the module
 * (`jest.mock('react-native-qrcode-svg', () => 'QRCode')`) has no
 * `__esModule`/`default` shape.
 */
type QRCodeComponent = typeof import('react-native-qrcode-svg').default
let qrCodeComponent: QRCodeComponent | undefined
function loadQRCode(): QRCodeComponent {
  if (!qrCodeComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-qrcode-svg')
    qrCodeComponent = (mod?.default ?? mod) as QRCodeComponent
  }
  return qrCodeComponent
}

/**
 * How often the inbox is re-read while this screen is in front.
 *
 * Five seconds is the "it just appeared" threshold without making the poll the
 * app's most frequent network call: it is one MessageBox list read, and it stops
 * entirely on blur, on background and during an accept.
 */
const INBOX_POLL_MS = 5000

// ── Needs attention ──────────────────────────────────────────────────────────
//
// Replaces the old accept list. An arriving payment is credited automatically
// (see autoAcceptInbox in the handle rail), so the only rows here are the ones
// the wallet could NOT credit after MAX_AUTO_ATTEMPTS tries, plus environmental
// failures still waiting on the network. That makes this a problem queue, not
// an inbox: every row offers a retry, and a discard for the structurally
// broken ones that will never succeed.
//
// There is deliberately no empty state. When nothing is wrong the section is
// absent entirely — an inbox that is always visible and always empty trains
// people to ignore it, and this is the one place that must be noticed.

interface AttentionSectionProps {
  readonly payments: IncomingPayment[]
  readonly attempts: Record<string, InboxAttempt>
  readonly damagedIds: ReadonlySet<string>
  readonly senderIdentities: Record<string, DisplayableIdentity | null>
  readonly busyId: string | null
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRetry: (p: IncomingPayment) => void
  readonly onDiscard: (p: IncomingPayment) => void
}

function AttentionSection({
  payments,
  attempts,
  damagedIds,
  senderIdentities,
  busyId,
  colors,
  t,
  onRetry,
  onDiscard
}: AttentionSectionProps) {
  if (payments.length === 0) return null
  return (
    <>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('pay_inbox_attention')}</Text>
      <Text style={[styles.attentionHint, { color: colors.textSecondary }]}>{t('pay_inbox_attention_hint')}</Text>
      <View
        style={[
          styles.paymentsList,
          { backgroundColor: colors.backgroundSecondary, borderColor: colors.warning + '40' }
        ]}
      >
        {payments.map((payment, idx) => {
          const id = String(payment.messageId)
          const isDamaged = damagedIds.has(id)
          const kind = attempts[id]?.kind
          const facing = userFacingPayError(attempts[id]?.error)
          const error = isDamaged
            ? t('payment_arrived_damaged')
            : kind === 'environmental'
              ? t('waiting_network_confirm')
              : facing.offerWalletCheck
                ? t(facing.key)
                : (attempts[id]?.error ?? '')
          return (
            <AttentionRow
              key={id}
              payment={payment}
              identity={senderIdentities[payment.sender ?? '']}
              error={error}
              offerWalletCheck={!isDamaged && kind !== 'environmental' && facing.offerWalletCheck}
              isDamaged={isDamaged}
              isLast={idx === payments.length - 1}
              isBusy={busyId === id}
              onRetry={() => onRetry(payment)}
              onDiscard={() => onDiscard(payment)}
              colors={colors}
              t={t}
            />
          )
        })}
      </View>
    </>
  )
}

interface AttentionRowProps {
  readonly payment: IncomingPayment
  readonly identity: DisplayableIdentity | null | undefined
  readonly error: string
  readonly offerWalletCheck?: boolean
  readonly isDamaged: boolean
  readonly isLast: boolean
  readonly isBusy: boolean
  readonly onRetry: () => void
  readonly onDiscard: () => void
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}

function AttentionRow({
  payment,
  identity,
  error,
  offerWalletCheck,
  isDamaged,
  isLast,
  isBusy,
  onRetry,
  onDiscard,
  colors,
  t
}: AttentionRowProps) {
  const Ionicons = loadIonicons()
  const senderKey = payment.sender ?? ''
  const satoshis = isDamaged ? undefined : satoshisFromToken(payment.token)?.satoshis
  return (
    <View
      style={[
        styles.paymentRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
      ]}
    >
      {identity?.avatarURL ? (
        <Image source={{ uri: identity.avatarURL }} style={styles.paymentAvatar} />
      ) : (
        <View style={[styles.paymentAvatarPlaceholder, { backgroundColor: colors.accent }]}>
          <Ionicons name="person" size={24} color={colors.background} />
        </View>
      )}

      <View style={styles.paymentInfo}>
        <Text style={[styles.paymentSenderName, { color: colors.textPrimary }]} numberOfLines={1}>
          {identity?.name ?? t('unknown')}
        </Text>
        <Text style={[styles.paymentSender, { color: colors.textSecondary }]} numberOfLines={1}>
          {identity?.abbreviatedKey ?? `${senderKey.slice(0, 16)}…`}
        </Text>
        {/* The reason, verbatim from the wallet. It is the only thing that tells
            the user whether a retry has any chance of working. */}
        {!!error && (
          <Text style={[styles.attentionError, { color: colors.warning }]} numberOfLines={2}>
            {error}
          </Text>
        )}

        <View style={[styles.attentionActions, { borderTopColor: colors.separator }]}>
          <TouchableOpacity
            onPress={onRetry}
            disabled={isBusy || isDamaged}
            style={[
              styles.attentionButton,
              { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator }
            ]}
          >
            {isBusy && !isDamaged ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text
                style={[
                  styles.attentionButtonText,
                  { color: isDamaged ? colors.textSecondary : colors.accent, opacity: isDamaged ? 0.4 : 1 }
                ]}
              >
                {t('retry')}
              </Text>
            )}
          </TouchableOpacity>
          {/* One tap opens a confirmation alert — uncommon irreversible action. */}
          <TouchableOpacity onPress={onDiscard} disabled={isBusy} style={styles.attentionButton}>
            <Text style={[styles.attentionButtonText, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('dismiss')}
            </Text>
          </TouchableOpacity>
          {offerWalletCheck && (
            <TouchableOpacity
              onPress={() => loadExpoRouter().router.push('/wallet-check' as never)}
              disabled={isBusy}
              style={styles.attentionButton}
            >
              <Text style={[styles.attentionButtonText, { color: colors.accent }]} numberOfLines={1}>
                {t('check_wallet')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {typeof satoshis === 'number' && (
        <View style={styles.paymentActions}>
          <Text style={[styles.paymentAmount, { color: colors.textSecondary }]}>
            <AmountDisplay>{satoshis}</AmountDisplay>
          </Text>
        </View>
      )}
    </View>
  )
}

export default function HandleReceive() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const QRCode = loadQRCode()
  const { useFocusEffect } = loadExpoRouter()
  const { managers, adminOriginator, selectedNetwork, storage, peekLastMissHeight } = useWallet()
  const wallet = managers?.permissionsManager || null
  const online = useOnline()

  const [identityKey, setIdentityKey] = useState('')
  const [identityError, setIdentityError] = useState(false)
  const [copied, setCopied] = useState(false)
  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [payments, setPayments] = useState<IncomingPayment[]>([])
  /** Inbox rows listIncomingPayments dropped or that fail token shape. */
  const [damaged, setDamaged] = useState<DamagedInboxMessage[]>([])
  const [senderIdentities, setSenderIdentities] = useState<Record<string, DisplayableIdentity | null>>({})
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  /**
   * The success moment, held until the payee acknowledges it. Set by the credit
   * pass; cleared only by the overlay's Done.
   */
  const [received, setReceived] = useState<{ amount: number; count: number } | null>(null)

  /** Payments the wallet has failed to credit, keyed by message id. */
  const [attempts, setAttempts] = useState<Record<string, InboxAttempt>>({})
  /** The row whose retry or discard is running. */
  const [busyId, setBusyId] = useState<string | null>(null)

  /** One inbox read at a time — see fetchPayments. */
  const fetchingRef = useRef(false)
  /** The live attempt map, for discard copy that must not close over stale state. */
  const attemptsRef = useRef<Record<string, InboxAttempt>>({})
  useEffect(() => {
    attemptsRef.current = attempts
  }, [attempts])

  /**
   * Whether this screen is the one on top. Pushing another route leaves this
   * component mounted, so mount alone is not "the user is looking at it".
   */
  const focusedRef = useRef(true)
  const identityInFlightRef = useRef(false)
  const loadIdentityKey = useCallback(async () => {
    if (!wallet || identityInFlightRef.current) return
    identityInFlightRef.current = true
    setIdentityError(false)
    try {
      const r = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
      if (r?.publicKey) setIdentityKey(r.publicKey)
    } catch {
      setIdentityError(true)
    } finally {
      identityInFlightRef.current = false
    }
  }, [wallet, adminOriginator])

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true
      if (!identityKey) void loadIdentityKey()
      return () => {
        focusedRef.current = false
      }
    }, [identityKey, loadIdentityKey])
  )

  const peerPayClient = useMemo<PeerPayClient | null>(() => {
    if (!isConfigured || !messageBoxUrl || !wallet) return null
    try {
      return new PeerPayClient({
        messageBoxHost: messageBoxUrl,
        walletClient: wallet as any,
        originator: adminOriginator
      })
    } catch {
      return null
    }
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const link = identityKey ? peerPayLinkFor(identityKey) : ''

  const handleCopy = useCallback(() => {
    if (!identityKey) return
    loadClipboard().setString(identityKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [identityKey])

  const handleShare = useCallback(() => {
    if (!link) return
    // Share.share rejects when the sheet is dismissed on some platforms; a
    // dismissed share sheet is not an error worth a toast.
    void Share.share({ message: link }).catch(() => {})
  }, [link])

  /**
   * Second chance for a payment whose proof no longer verifies. The token's
   * merkle path was minted at send time and a reorg since then invalidates it
   * without changing the transaction, so the proof is re-fetched by txid. Only
   * consulted after internalizeAction has already failed, and it declines while
   * offline — see core/pay/beefRepair.ts.
   */
  const repairBeef = useMemo(
    () => makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline }),
    [selectedNetwork]
  )

  const internalize = useCallback(
    async (payment: IncomingPayment, description: string) => {
      const client = peerPayClient
      if (!client || !wallet) throw new Error(t('wallet_not_ready'))
      await internalizeIncoming(wallet as any, client, adminOriginator, payment, description, repairBeef)
    },
    [peerPayClient, wallet, adminOriginator, t, repairBeef]
  )

  const applyCreditResult = useCallback((outcome: CreditInboxResult) => {
    TaskCreditInbox.lastAttentionCount = outcome.attentionCount
    attemptsRef.current = outcome.attempts
    setAttempts(outcome.attempts)
    setPayments(outcome.displayPayments)
    setDamaged(outcome.damaged)
    if (outcome.accepted > 0) {
      // Full screen and held until acknowledged, not a toast. Money arriving
      // can be missed entirely — phone face down, in a pocket, not being
      // looked at — and whether it landed is the one thing a payee must never
      // be left unsure about. Everything not left in the attempt map was
      // credited, so that is what the figure sums.
      const credited = outcome.payments.filter(p => !outcome.attempts[String(p.messageId)])
      setReceived({
        amount: credited.reduce((sum, p) => sum + (satoshisFromToken(p.token)?.satoshis ?? 0), 0),
        count: outcome.accepted
      })
    }
  }, [])

  const runCredit = useCallback(
    async (force?: string[]) => {
      const client = peerPayClient
      if (!client || !messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return undefined
      const classify = await makeCreditClassifier({
        getOnline: () => online,
        peekLastMissHeight
      })
      const outcome = await creditInboxOnce({
        client,
        messageBoxUrl,
        storage: storage ?? undefined,
        force,
        classify,
        accept: payment => acceptWithRetry(client, messageBoxUrl, payment, INBOX_DESCRIPTION, internalize)
      })
      applyCreditResult(outcome)
      return outcome
    },
    [peerPayClient, messageBoxUrl, storage, online, peekLastMissHeight, internalize, applyCreditResult]
  )

  const fetchPayments = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const client = peerPayClient
      if (!client || !messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return
      // One read at a time. The poll, the refresh button and every accept all
      // reach this, and two overlapping reads can land out of order — the older
      // response winning would resurrect a row that was just internalized.
      if (fetchingRef.current) return
      fetchingRef.current = true
      try {
        const outcome = await runCredit()
        const displayList = outcome?.displayPayments ?? []
        const idClient = makeIdentityClient(wallet as any, adminOriginator)
        if (idClient) {
          const senders = [...new Set(displayList.map(p => p.sender).filter(Boolean))] as string[]
          const entries = await Promise.all(senders.map(s => resolveIdentity(idClient, s)))
          setSenderIdentities(Object.fromEntries(entries))
        }
      } catch (error: any) {
        // A silent read is a poll the user did not ask for, so it fails quietly:
        // at one read every few seconds, a dead network would otherwise raise a
        // toast per tick. Only a read the user triggered reports failure.
        if (!options.silent) {
          showToast(`${t('connection_failed')}: ${error?.message || t('unknown_error')}`, { type: 'error' })
        }
      } finally {
        fetchingRef.current = false
      }
    },
    [peerPayClient, messageBoxUrl, wallet, adminOriginator, t, runCredit]
  )

  useEffect(() => {
    void fetchPayments()
  }, [fetchPayments])

  // Read through a ref so the poll below depends only on the client, and is
  // never torn down and restarted by an unrelated re-render.
  const fetchRef = useRef(fetchPayments)
  useEffect(() => {
    fetchRef.current = fetchPayments
  }, [fetchPayments])

  // ── Poll the inbox ──
  //
  // A payment arrives whenever the sender's wallet delivers it and MessageBox has
  // no push channel here, so "it appears on its own" means polling — but only
  // while someone is actually looking at this screen. Unmount and blur stop it
  // because a poll nobody can see spends battery; a backgrounded app stops it
  // for the same reason and because iOS will suspend the timer anyway. The
  // shared creditInboxOnce mutex serializes with TaskCreditInbox.
  useEffect(() => {
    if (!peerPayClient) return
    let cancelled = false

    const tick = () => {
      if (cancelled || !focusedRef.current) return
      if (AppState.currentState !== 'active') return
      void fetchRef.current({ silent: true })
    }

    const interval = setInterval(tick, INBOX_POLL_MS)
    // Returning to the app should show what arrived while it was away, rather
    // than waiting out the rest of an interval.
    const appSubscription = AppState.addEventListener('change', next => {
      if (next === 'active') tick()
    })

    return () => {
      cancelled = true
      clearInterval(interval)
      appSubscription.remove()
    }
  }, [peerPayClient])

  /** Retry one row that had given up. Runs the whole pass, forcing this id. */
  const handleRetry = useCallback(
    async (payment: IncomingPayment) => {
      const id = String(payment.messageId)
      if (damaged.some(d => d.messageId === id)) return
      setBusyId(id)
      try {
        await runCredit([id])
      } finally {
        setBusyId(null)
      }
    },
    [runCredit, damaged]
  )

  /**
   * Give up on a row. One tap opens a confirmation alert; confirming NACKs the
   * sender then acks. If the NACK fails the row stays.
   */
  const handleDiscard = useCallback(
    async (payment: IncomingPayment) => {
      const client = peerPayClient
      if (!client) return
      const id = String(payment.messageId)
      const isDamaged = damaged.some(d => d.messageId === id)
      const voided = !isDamaged && attemptsRef.current[id]?.kind === 'double_spend'
      const choice = await showAlert(
        voided
          ? {
              title: t('discard_void_title'),
              message: t('discard_void_body'),
              buttons: [{ text: t('done'), key: 'done' }]
            }
          : {
              title: t('discard_payment_title'),
              message: t('discard_payment_body'),
              buttons: [
                { text: t('cancel'), style: 'cancel', key: 'cancel' },
                { text: t('discard'), style: 'destructive', key: 'discard' }
              ]
            }
      )
      if (voided ? choice !== 'done' : choice !== 'discard') return
      setBusyId(id)
      try {
        const reason = isDamaged ? 'corrupt' : voided ? 'double_spent' : 'uncreditible'
        await discardIncoming(client, payment, reason)
        // Drop it locally too: it will never be listed again, so waiting for the
        // next poll would leave a row on screen that no longer exists.
        setAttempts(prev => {
          const next = { ...prev }
          delete next[id]
          attemptsRef.current = next
          if (storage) void saveInboxAttempts(storage, next)
          return next
        })
        setDamaged(prev => prev.filter(d => d.messageId !== id))
        setPayments(prev => prev.filter(p => String(p.messageId) !== id))
        TaskCreditInbox.lastAttentionCount = Math.max(0, TaskCreditInbox.lastAttentionCount - 1)
        setResult({ type: 'success', message: t('pay_dismissed') })
      } catch (e: any) {
        showToast(e?.message || t('unknown_error'), { type: 'error' })
      } finally {
        setBusyId(null)
        setTimeout(() => setResult(null), 5000)
      }
    },
    [peerPayClient, damaged, t, storage]
  )

  const damagedIds = useMemo(() => new Set(damaged.map(d => d.messageId)), [damaged])

  /**
   * The rows worth showing: payments the wallet has given up on, environmental
   * failures still waiting on the network, plus inbox bodies that never parsed
   * into tokens. Everything else was credited.
   */
  const attention = useMemo(
    () =>
      payments.filter(p => {
        const id = String(p.messageId)
        return damagedIds.has(id) || needsAttention(attempts[id]) || attempts[id]?.kind === 'environmental'
      }),
    [payments, attempts, damagedIds]
  )

  return (
    // Scrolls, because a 240pt QR plus the inbox overflows a small screen and a
    // note being edited puts the keyboard over the row that owns it.
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {/* The way into the message-box settings, and the active host. Without it a
          user who saved a broken host has no route back to reset or clear it. */}
      <MessageBoxBar
        url={config.messageBoxUrl}
        open={config.showConfig}
        onToggle={() => config.setShowConfig(v => (config.messageBoxUrl === NO_MESSAGE_BOX ? true : !v))}
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

      {/* Your handle. The QR is the focal element — it is the thing physically
          held up to another device. */}
      <View style={styles.qrHero}>
        {identityKey ? (
          <View style={styles.qrPlate}>
            <QRCode value={identityKey} size={240} color="#000" backgroundColor="#fff" />
          </View>
        ) : identityError ? (
          <View style={styles.identityError}>
            <Text style={[styles.identityErrorText, { color: colors.error }]}>{t('unknown_error')}</Text>
            <PressableScale
              onPress={() => void loadIdentityKey()}
              haptic="tap"
              style={styles.identityRetry}
              accessibilityRole="button"
              accessibilityLabel={t('activity_load_retry')}
            >
              <Text style={[styles.identityRetryLabel, { color: colors.accent }]}>{t('activity_load_retry')}</Text>
            </PressableScale>
          </View>
        ) : (
          <ActivityIndicator size="large" color={colors.textSecondary} />
        )}
      </View>

      <Text style={[styles.keyText, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
        {identityKey}
      </Text>

      <View style={styles.actionRow}>
        <TouchableOpacity onPress={handleCopy} style={[styles.action, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={18}
            color={copied ? colors.success : colors.textSecondary}
          />
          <Text style={[styles.actionText, { color: copied ? colors.success : colors.textSecondary }]}>
            {copied ? t('copied') : t('pay_copy')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          disabled={!link}
          style={[styles.action, { backgroundColor: colors.fillTertiary, opacity: link ? 1 : 0.5 }]}
        >
          <Ionicons name="share-outline" size={18} color={colors.textSecondary} />
          <Text style={[styles.actionText, { color: colors.textSecondary }]}>{t('pay_share_link')}</Text>
        </TouchableOpacity>
      </View>

      {/* Only the payments the wallet gave up on. Everything else was credited
          the moment it was seen, so there is nothing here to accept. */}
      {isConfigured && (
        <AttentionSection
          payments={attention}
          attempts={attempts}
          damagedIds={damagedIds}
          senderIdentities={senderIdentities}
          busyId={busyId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onDiscard={handleDiscard}
        />
      )}
      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} colors={colors} />}

      {/* The moment money arrives. A Modal, so it covers the header too. */}
      {received && (
        <ReceivedOverlay amount={received.amount} count={received.count} onDismiss={() => setReceived(null)} />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Needs attention
  attentionHint: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  attentionError: {
    ...typography.caption1,
    marginTop: spacing.xs
  },
  attentionActions: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm
  },
  attentionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2
  },
  attentionButtonText: {
    ...typography.subhead,
    fontWeight: '500'
  },

  // Your handle
  qrHero: {
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  qrPlate: {
    padding: spacing.lg,
    borderRadius: radii.xl,
    backgroundColor: '#fff'
  },
  identityError: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  identityErrorText: { ...typography.subhead, textAlign: 'center' },
  identityRetry: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  identityRetryLabel: { ...typography.subhead, fontWeight: '600' },
  keyText: {
    ...typography.caption1,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: spacing.md
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xl
  },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md
  },
  actionText: {
    ...typography.subhead,
    fontWeight: '500'
  },

  // Section
  sectionTitle: {
    ...typography.title3,
    marginBottom: spacing.md
  },

  // Incoming payments
  paymentsList: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md
  },
  paymentAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    flexShrink: 0
  },
  paymentAvatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  paymentInfo: {
    flex: 1,
    minWidth: 0
  },
  paymentSenderName: {
    ...typography.subhead,
    fontWeight: '600',
    marginBottom: 1
  },
  paymentSender: {
    ...typography.caption1,
    fontFamily: 'monospace',
    marginBottom: spacing.xs
  },
  paymentActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    flexShrink: 0
  },
  paymentAmount: {
    ...typography.footnote,
    fontWeight: '700'
  }
})
