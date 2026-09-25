/**
 * Pay → anyone.
 *
 * One recipient field decides the rail: a base58check address goes out as a
 * plain P2PKH payment; an identity key, peerpay link or search hit goes out as
 * a PeerPay token dropped in the recipient's message box; a nearby-session
 * code is handed up to the Pay screen, which swaps this form for NearbyFlow.
 * Nothing here is chosen by the user except the recipient and the amount.
 *
 * The form recomposes by what the field resolved to: a note field is shown
 * for both handles and addresses (in BSV mode — a token has no address rail
 * at all, D4). For a handle the note is sent to the counterparty and becomes
 * their action's description; for an address there is no counterparty
 * channel to carry it over, so it is purely the sender's own record for
 * their own outbound description. The "they are not notified" consequence is
 * shown only for addresses, where it is load-bearing — a user who pastes an
 * address expecting messaging-style delivery has effectively posted cash.
 */
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useState, useRef } from 'react'
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
import RecipientField, { type RecipientRow } from './RecipientField'
import StepBar, { type PayStep } from './StepBar'
import { useMessageBoxConfig } from './MessageBoxConfig'
import { useRecipientInput, type RecipientTarget, type PeerPayRequest } from './useRecipientInput'
import { tokenSendCopy, tokenThrowCopy, type TokenSendCopy } from './tokenSendCopy'
import { useAssetStatus, useMandala } from '../../hooks/useMandala'
import { useSpendableBalance } from '../../hooks/useSpendableBalance'
import { useContactsStore } from '../../hooks/useContactsStore'
import ContactSigil from '../wallet/ContactSigil'
import { formatTokenAmount, formatTokenAmountWithUnit } from '../../tokenFormat'
import { abbreviateKey } from '../../../core/pay/counterparty'
import type { ContactRow } from '../../../core/contacts/contactsStore'
import { createHandleRegistryClient } from '../../../core/identity/handleRegistry/client'
import type { RegistryProfile } from '../../../core/identity/handleRegistry/profileCert'
import {
  useTheme,
  spacing,
  typography,
  radii,
  hitTargets,
  formatSatoshisAsBsvDecimal,
  useWallet,
  useWalletManagers,
  useWalletStatus,
  CONSEQUENCE_KEYS,
  NO_MESSAGE_BOX,
  addressNetwork,
  cancelOutboxPayment,
  classifyRecipientInput,
  getHandleRegistryConfig,
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
import type { DismissTarget } from '../../dismissTarget'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes.
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

/** The registry's own debounce. Deliberately a third constant rather than a
 * shared one: `useRecipientInput`'s overlay timer and `ProfileScreen`'s
 * availability timer are separate decisions that happen to agree today. */
const REGISTRY_SEARCH_DEBOUNCE_MS = 400

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

/**
 * What the host screen can ask of the form: walk back one step. Returns false
 * when already on the first step, so the host knows to leave the screen
 * instead — the header's one back chevron serves both (2026-09-18 design: no
 * second back control inside the form).
 */
export interface UniversalSendHandle {
  back(): boolean
}

export interface UniversalSendProps {
  /** A recipient known before the form opened: a peerpay deep link or `?identityKey=`. */
  initialTarget?: Extract<RecipientTarget, { kind: 'handle' }>
  /** Prefilled amount in satoshis from a peerpay link or `?sats=`. */
  initialSats?: number
  /**
   * Prefilled TOKEN amount from a peerpay link's `asset=`/`amount=`: base units
   * of that asset. Takes precedence over `initialSats` — a link names one money.
   * The figure only ever shows while that asset is the one selected (see the
   * unit tag on the figure below), so a link for a token this wallet turns out
   * not to hold seeds nothing.
   */
  initialTokenAmount?: { assetId: string; baseUnits: number }
  /**
   * The asset this payment is denominated in. `null` is BSV — the default, and
   * what every existing flow assumes. Controlled by the Pay screen so the
   * choice survives a hop into Get paid and back.
   */
  selectedAssetId?: string | null
  onSelectAsset?: (assetId: string | null) => void
  /** Error text from a malformed peerpay link, shown as a banner. */
  initialNotice?: string | null
  /** Open the scanner as soon as the form mounts (deep link `cell=pay-nearby`). */
  openScannerOnMount?: boolean
  /** A nearby-session code was scanned. The Pay screen swaps this form for NearbyFlow. */
  onNearbySession: (session: Session) => void
  /** Where the post-payment overlay sends the user. Defaults to `/`. */
  dismissTo?: DismissTarget
  /** Which of the three steps is on screen — the host names its header by it. */
  onStepChange?: (step: PayStep) => void
}

/**
 * The typed (or link-supplied) figure, tagged with the unit it was entered in:
 * `null` for satoshis, an assetId for that token's base units.
 */
interface Figure {
  text: string
  unit: string | null
}

function seedFigure(sats?: number, token?: { assetId: string; baseUnits: number }): Figure {
  if (token && Number.isFinite(token.baseUnits) && token.baseUnits > 0) {
    return { text: String(Math.round(token.baseUnits)), unit: token.assetId }
  }
  if (sats && sats > 0) return { text: String(sats), unit: null }
  return { text: '', unit: null }
}

function UniversalSendInner(
  {
    initialTarget,
    initialSats,
    initialTokenAmount,
    initialNotice,
    openScannerOnMount = false,
    onNearbySession,
    selectedAssetId,
    onSelectAsset,
    dismissTo = '/',
    onStepChange
  }: UniversalSendProps,
  ref: React.ForwardedRef<UniversalSendHandle>
) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const StatusBar = loadStatusBar()
  const Ionicons = loadIonicons()
  const { managers, adminOriginator, storage } = useWalletManagers()
  const { walletBuilt } = useWalletStatus()
  const { walletUserId, selectedNetwork } = useWallet()
  const wallet = managers?.permissionsManager || null

  // ── the three-step flow (who / amount / review, 2026-09-18 design) ──────
  // A recipient known before the form opened (a deep link, a scan on the way
  // in) starts on 'amount' — the identity is already decided. Everything
  // else about this form is unchanged; `step` only decides which of the
  // sections below is on screen.
  const [step, setStep] = useState<PayStep>(initialTarget ? 'amount' : 'who')
  // A second deep link while this form is mounted re-adopts the recipient
  // (see useRecipientInput's own initialTarget effect) and must jump the
  // step forward the same way the initial mount does — a link naming a
  // payee is a stronger signal than whatever step the user was on.
  useEffect(() => {
    if (initialTarget) setStep('amount')
  }, [initialTarget?.identityKey])
  const contactsStore = useContactsStore()
  const [contactMatches, setContactMatches] = useState<ContactRow[]>([])
  const [registryMatches, setRegistryMatches] = useState<RegistryProfile[]>([])
  const [registrySearching, setRegistrySearching] = useState(false)
  const [registryError, setRegistryError] = useState(false)
  /**
   * Two strings, not the config object. `getHandleRegistryConfig` builds a
   * fresh `{ domain, url }` on every call, so memoising on the object gives the
   * client a new identity every render, which gives the registry effect below a
   * changed dependency every render — and its own `setState` then schedules the
   * next render. That is an unbreakable loop ("Maximum update depth exceeded")
   * in which the 400 ms debounce is also cleared before it can ever fire.
   */
  const registry = getHandleRegistryConfig(selectedNetwork)
  const registryDomain = registry?.domain
  const registryUrl = registry?.url
  const registryClient = useMemo(
    () =>
      registryDomain && registryUrl
        ? createHandleRegistryClient({ pinned: { domain: registryDomain, url: registryUrl } })
        : null,
    [registryDomain, registryUrl]
  )

  // ── the asset axis ──────────────────────────────────────────────────
  // Every line below is gated on `asset`: with no token held, `balances` is
  // empty, `asset` is null, the picker renders nothing and this form is
  // byte-for-byte the form it was.
  const mandala = useMandala()
  const spendableSats = useSpendableBalance()
  const [localAssetId, setLocalAssetId] = useState<string | null>(null)
  const assetId = selectedAssetId !== undefined ? selectedAssetId : localAssetId
  const setAssetId = onSelectAsset ?? setLocalAssetId
  const balances = mandala.balances ?? []
  const holding = balances.find(b => b.asset.assetId === assetId) ?? null
  const asset = holding?.asset ?? null
  const issuer = asset?.issuerName || t('token_issuer_fallback')
  /**
   * Regulatory/registry facts for the selected asset (paused, frozen, this
   * wallet's own registration, whether the metadata even resolved), from the
   * runtime's ~10s cache. `null` (unknown/loading) blocks nothing — ux §4.2
   * rule 3: pre-flight may only ever say "no", never invent a "yes" and never
   * gate on an answer it does not have yet.
   */
  const assetStatus = useAssetStatus(asset?.assetId ?? null).status

  // Read-only here: the server is configured in Settings › Advanced.
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  /**
   * The figure, tagged with the unit it was entered in. The field shows it and
   * a send reads it ONLY while that unit is the one in force — an asset counts
   * only once this wallet is known to hold it — so any change of money (the
   * picker, a link naming a different one, the screen dropping an asset that
   * turns out not to be held) blanks the figure instead of letting "2500" be
   * read as 25.00 USDX one moment and 2,500 satoshis the next.
   */
  const [figure, setFigure] = useState<Figure>(() => seedFigure(initialSats, initialTokenAmount))
  const unit = asset?.assetId ?? null
  const sendAmount = figure.unit === unit ? figure.text : ''
  const setSendAmount = (text: string) => setFigure({ text, unit })
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  // XR-061: synchronous in-flight latch for handleSend. `isSending` is React
  // state and only takes effect on the next render, so two activations in the
  // same JS turn (double-tap, or two gesture callbacks before the disabled
  // prop reaches the native view) would both pass its checks; this ref is
  // read-and-set before any await.
  const sendingRef = useRef(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  /**
   * The failed-token-send note, kept apart from `sendResult` because it carries
   * an action ("Check again") that a plain banner has nowhere to put.
   */
  const [tokenFailure, setTokenFailure] = useState<TokenSendCopy | null>(null)
  /** The success moment, held until acknowledged — same screen as every rail. */
  const [sent, setSent] = useState<{
    amount: number
    recipient?: string
    /** Set only for a handle/token send — offers "Add to contacts" on the success screen. */
    recipientIdentityKey?: string
    /** Token mode: the figure in the asset's own units. */
    amountText?: string
    /** Whether the issuer has confirmed it yet — never claimed, only reported. */
    statusNote?: string
  } | null>(null)
  /** Set once `sent` names a handle recipient who is not already a saved
   * contact — null while that check is pending or once it comes back "already saved". */
  const [offerAddContact, setOfferAddContact] = useState<{
    identityKey: string
    name?: string
    handle?: string
  } | null>(null)
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  /**
   * A token request, decided against a KNOWN set of holdings: the form
   * switches to that token when this wallet holds it and takes `amount` in
   * its base units (or leaves the figure to the user for an open request). A
   * token this wallet does not hold cannot be paid from here, so the
   * recipient is kept, the figure is not — a figure typed for the previous
   * money must never stay armed at the new payee — and the banner says why;
   * paying that person in BSV is still one tap away.
   */
  const applyTokenRequest = (
    request: PeerPayRequest,
    balances: { asset: { assetId: string } }[],
    opts: { deferred: boolean }
  ) => {
    const held = balances.some(b => b.asset.assetId === request.asset)
    if (!held) {
      // Back to BSV, as the banner says; the figure typed for the old money
      // must never stay armed at the new payee.
      setAssetId(null)
      setFigure(current => ({ ...current, text: '' }))
      setNotice({ type: 'error', message: t('pay_asset_link_not_held') })
      return
    }
    setAssetId(request.asset as string)
    // A request applied LATER never writes over a figure the user has typed
    // since; the link's own figure is taken only at the moment the link arrives.
    if (!opts.deferred || figure.text === '') {
      setFigure({ text: request.amount ? String(request.amount) : '', unit: request.asset as string })
    }
    setNotice(null)
    setTokenFailure(null)
  }
  /**
   * Whether this wallet can EVER hold a token here. The runtime is published at
   * wallet build, and only on a chain with Mandala endpoints — so no runtime on
   * a built wallet is a settled fact (holds nothing, ever), while no runtime on
   * a wallet still building is merely unknown.
   */
  const tokensNever = walletBuilt && !mandala.available
  /**
   * A token link that arrived before the first balance read landed. `null`
   * balances mean UNKNOWN, never "holds nothing" (useMandala's contract), and a
   * pre-flight may only ever say "no" to a fact it has — so the request waits,
   * and the effect below decides it the moment the holdings are known.
   */
  const pendingTokenRequestRef = useRef<PeerPayRequest | null>(null)
  /**
   * A pasted or scanned link named a money, and maybe a figure. `sats` is a
   * BSV request: the form switches to BSV and takes the figure. `asset` is a
   * token request, decided now if the holdings are known (or can never be
   * held), otherwise parked until they are — see the effect below `recipient`.
   */
  const onPeerPayRequest = (request: PeerPayRequest) => {
    // A request that names money (a link's `sats=`/`amount=`, typed, pasted or
    // scanned) is "amount pre-populated by QR/deep link" whichever way it
    // arrived — so it jumps the same way a deep-linked `initialTarget` does.
    // A bare handle/key with no figure never reaches this function at all
    // (see useRecipientInput's `requestOf`), so Continue still decides step
    // for every ordinary "who" entry.
    setStep('amount')
    if (request.asset !== undefined) {
      if (tokensNever) {
        applyTokenRequest(request, [], { deferred: false })
      } else if (mandala.balances === null) {
        pendingTokenRequestRef.current = request
      } else {
        applyTokenRequest(request, mandala.balances, { deferred: false })
      }
      return
    }
    if (request.sats !== undefined) {
      pendingTokenRequestRef.current = null
      setAssetId(null)
      setFigure({ text: String(request.sats), unit: null })
      setNotice(null)
      setTokenFailure(null)
    }
  }
  const onPeerPayError = useCallback((message: string) => setNotice({ type: 'error', message }), [])
  const recipient = useRecipientInput({
    wallet,
    adminOriginator,
    initialTarget,
    onPeerPayRequest,
    onPeerPayError,
    onNearbySession
  })
  const target = recipient.target

  // Local contacts, searched ahead of the 400ms overlay debounce (instant —
  // this is a local SQLite read) and merged into the same dropdown. Contacts
  // come first; an overlay hit for an identity key already in the merged list
  // is dropped rather than shown twice. An empty query shows every contact as
  // "Recent" (RecipientField's `recentLabel`) rather than nothing.
  useEffect(() => {
    if (!contactsStore || walletUserId === null || recipient.selectedIdentity || target) {
      setContactMatches([])
      return
    }
    let cancelled = false
    void contactsStore.searchContacts(walletUserId, recipient.inputText).then(rows => {
      if (!cancelled) setContactMatches(rows)
    })
    return () => {
      cancelled = true
    }
  }, [contactsStore, walletUserId, recipient.inputText, recipient.selectedIdentity, target])

  /**
   * The registry tier: people who can be paid by name. Its own timer — the
   * contacts effect above has none, which is right for a local SQLite read and
   * would be one request per keystroke here — and its own notice, so a
   * registry outage never takes the contacts already on screen with it.
   *
   * It never fires for text that already resolved to a key or an address
   * (`classifyRecipientInput`), for fewer than two characters (shorter than
   * the registry's own minimum), with no registry configured, or before the
   * wallet user is known.
   */
  useEffect(() => {
    const query = recipient.inputText.trim()
    const routable =
      !!registryClient &&
      typeof walletUserId === 'number' &&
      !recipient.selectedIdentity &&
      !target &&
      classifyRecipientInput(query).kind === 'search' &&
      query.length >= 2
    if (!routable) {
      // Only here, and only when there is something to clear: an unconditional
      // `setRegistryMatches([])` hands React a new array reference on every
      // run, which it can never bail out of.
      setRegistryMatches(rows => (rows.length === 0 ? rows : []))
      setRegistrySearching(false)
      return
    }
    let cancelled = false
    setRegistrySearching(true)
    const timer = setTimeout(async () => {
      try {
        const rows = await registryClient.search(query)
        if (cancelled) return
        setRegistryMatches(rows)
        setRegistryError(false)
      } catch (error) {
        console.error('Handle registry search error:', error)
        if (cancelled) return
        setRegistryMatches([])
        setRegistryError(true)
      } finally {
        if (!cancelled) setRegistrySearching(false)
      }
    }, REGISTRY_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [registryClient, walletUserId, recipient.inputText, recipient.selectedIdentity, target])

  const mergedSearchResults = useMemo((): RecipientRow[] => {
    const contactIdentities: RecipientRow[] = contactMatches.map(c => ({
      identityKey: c.identityKey,
      name: c.name,
      avatarURL: c.cachedAvatarUrl ?? '',
      abbreviatedKey: abbreviateKey(c.identityKey),
      badgeIconURL: '',
      badgeLabel: '',
      badgeClickURL: '',
      ...(c.cachedHandle ? { secondaryLine: c.cachedHandle } : {})
    }))
    const seen = new Set(contactIdentities.map(c => c.identityKey))
    // Contacts, then the registry, then the overlay. A person the user has
    // already labelled is shown with that label; a registry row states the
    // name the owner published and the handle it belongs to.
    //
    // One key, one row, across the WHOLE list — so `seen` is consulted and
    // added to in the same pass. Filtering first would let two certificates
    // for one subject through together, which the pinned registry cannot
    // produce but a foreign host answering `search` can.
    const registryIdentities: RecipientRow[] = []
    for (const p of registryMatches) {
      if (seen.has(p.identityKey)) continue
      seen.add(p.identityKey)
      // The pinned registry's own certificate is the app's actual vetting —
      // writes only ever go there (handleRegistry/client.ts). A foreign
      // domain's `search` hit is only as trustworthy as that domain's own
      // DNS + TLS (the same level paymail already offers), so it earns a
      // different badge rather than being dressed as "Registered" (misc-p2-14).
      const ownDomain = !!registryClient && p.domain.toLowerCase() === registryClient.domain.toLowerCase()
      registryIdentities.push({
        identityKey: p.identityKey,
        // A display name is the owner's own unvalidated plaintext, and this row
        // is the one place it is drawn ABOVE the handle it belongs to. A name
        // shaped like an address therefore reads as somebody else's
        // `handle@domain` — and it is the name, not the handle, that the field
        // and the review card carry from here on. A name that can be mistaken
        // for an address is no name.
        name: (p.displayName?.includes('@') ? '' : p.displayName) || p.handle,
        avatarURL: '',
        abbreviatedKey: abbreviateKey(p.identityKey),
        badgeIconURL: '',
        badgeLabel: ownDomain
          ? t('pay_trust_handle_attested')
          : t('pay_trust_handle_domain_attested', { domain: p.domain }),
        badgeClickURL: '',
        secondaryLine: p.paymail
      })
    }
    return [
      ...contactIdentities,
      ...registryIdentities,
      ...recipient.searchResults.filter(r => !seen.has(r.identityKey))
    ]
  }, [contactMatches, registryMatches, recipient.searchResults, registryClient, t])

  /**
   * The handle of the row the user picked, so the success screen's "Save as
   * contact" can carry it into the new contact — held against the KEY it
   * belongs to, not as a bare string.
   *
   * `handleSend` clears the field through the hook's own `clearRecipient`
   * rather than the wrapper below, deliberately, so this survives the send and
   * the overlay can still read it. A bare string would therefore also outlive
   * its owner: pay someone with a handle, then pay a pasted key from the same
   * mounted form, and the second person would be offered for saving with the
   * first person's `handle@domain`.
   */
  const selectedHandleRef = useRef<{ identityKey: string; handle: string } | undefined>(undefined)
  /**
   * The same fact, as state, for the review card — which is the one screen
   * whose whole job is the last check before money moves, and which otherwise
   * draws a name over an abbreviated key and never shows the `handle@domain`
   * being paid at all. State rather than the ref above because the card is
   * rendered, and a ref does not re-render; both rather than one because the
   * ref must outlive the send and this must not survive a new recipient.
   */
  const [pickedHandle, setPickedHandle] = useState<{ identityKey: string; handle: string } | null>(null)
  const onSelectIdentity = (identity: RecipientRow) => {
    const picked = identity.secondaryLine?.includes('@')
      ? { identityKey: identity.identityKey, handle: identity.secondaryLine }
      : undefined
    selectedHandleRef.current = picked
    setPickedHandle(picked ?? null)
    recipient.selectIdentity(identity)
  }
  const onClearRecipient = () => {
    selectedHandleRef.current = undefined
    setPickedHandle(null)
    recipient.clearRecipient()
  }
  // Whether the resolved recipient is already a saved contact — the review
  // step's trust tag names this before "registered"/"unverified".
  const [targetIsContact, setTargetIsContact] = useState(false)
  useEffect(() => {
    if (!contactsStore || walletUserId === null || target?.kind !== 'handle') {
      setTargetIsContact(false)
      return
    }
    let cancelled = false
    void contactsStore.getContact(walletUserId, target.identityKey).then(c => {
      if (!cancelled) setTargetIsContact(!!c)
    })
    return () => {
      cancelled = true
    }
  }, [contactsStore, walletUserId, target])

  // The success screen's "Add to contacts" offer: only for a handle send, and
  // only once confirmed absent from contacts (checked fresh here rather than
  // reusing `targetIsContact` — `target` may already be cleared by the time
  // this runs, and a check against the stale ONE this send actually used is
  // what the button must reflect).
  useEffect(() => {
    setOfferAddContact(null)
    if (!sent?.recipientIdentityKey || !contactsStore || walletUserId === null) return
    let cancelled = false
    const identityKey = sent.recipientIdentityKey
    void contactsStore.getContact(walletUserId, identityKey).then(c => {
      if (cancelled || c) return
      // Only the handle of the person actually paid: see selectedHandleRef.
      const picked = selectedHandleRef.current
      setOfferAddContact({
        identityKey,
        name: sent.recipient,
        ...(picked?.identityKey === identityKey ? { handle: picked.handle } : {})
      })
    })
    return () => {
      cancelled = true
    }
  }, [sent, contactsStore, walletUserId])

  const onAddContact = useCallback(() => {
    if (!offerAddContact) return
    setSent(null)
    loadExpoRouter().router.push({
      pathname: '/contact/add',
      params: {
        identityKey: offerAddContact.identityKey,
        name: offerAddContact.name ?? '',
        handle: offerAddContact.handle ?? '',
        source: 'pay'
      }
    } as never)
  }, [offerAddContact])

  /**
   * A token link that arrived before the holdings were known. `null` balances
   * mean UNKNOWN, never "holds nothing" (useMandala's contract), and a
   * pre-flight may only ever say "no" to a fact it has — so the request waits
   * here and is decided the moment the holdings land (or the wallet finishes
   * building with no token runtime). Applied only if the recipient is still
   * the payee the link named: the user may have retargeted while it waited,
   * and a figure in a money nobody at the new payee asked for must never arm.
   */
  const balancesKnown = mandala.balances !== null
  useEffect(() => {
    const pending = pendingTokenRequestRef.current
    if (!pending) return
    if (!tokensNever && mandala.balances === null) return
    pendingTokenRequestRef.current = null
    if (target?.kind !== 'handle' || target.identityKey !== pending.identityKey) return
    applyTokenRequest(pending, tokensNever ? [] : (mandala.balances ?? []), { deferred: true })
    // Keyed on the two events that can settle a parked request; everything
    // else it reads is a plain closure over this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balancesKnown, mandala.balances, tokensNever])

  /**
   * Whether the issuer's registry admits the typed recipient, for the ONE
   * asset selected — the counterpart to `recipientRefusal`'s synchronous D4
   * (address-shape) check, which never touches the registry at all. Asked
   * only once the field has RESOLVED to an identity key: half-typed text is
   * not a recipient, and `undefined` (unknown/still asking) never disables
   * the CTA — only a proven `false` does (ux §4.2 rule 3).
   */
  const [recipientAdmitted, setRecipientAdmitted] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    setRecipientAdmitted(undefined)
    if (!asset || target?.kind !== 'handle' || !assetStatus) return
    let live = true
    void assetStatus
      .recipientAdmitted(target.identityKey)
      .then(admitted => {
        if (live) setRecipientAdmitted(admitted)
      })
      .catch(() => {
        // Fails open, same as every other pre-flight read: an unreachable
        // registry is UNKNOWN, never a proven refusal.
        if (live) setRecipientAdmitted(undefined)
      })
    return () => {
      live = false
    }
  }, [asset, target, assetStatus])

  // A second deep link while mounted re-adopts the recipient (useRecipientInput);
  // the amount and the notice it carried must follow, or Pay sends the OLD
  // figure to the NEW person.
  // Keyed on the figure's parts, not the object: a host that rebuilds the
  // token-amount object every render must not reseed over what is being typed.
  const initialTokenAssetId = initialTokenAmount?.assetId
  const initialTokenBaseUnits = initialTokenAmount?.baseUnits
  useEffect(() => {
    setFigure(
      seedFigure(
        initialSats,
        initialTokenAssetId !== undefined && initialTokenBaseUnits !== undefined
          ? { assetId: initialTokenAssetId, baseUnits: initialTokenBaseUnits }
          : undefined
      )
    )
  }, [initialSats, initialTokenAssetId, initialTokenBaseUnits])
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
      setSent({
        amount: paidSats,
        recipient: recipient.selectedIdentity?.name,
        recipientIdentityKey: to.identityKey,
        // The handle rail always drops the payment in the recipient's message
        // box rather than handing it over in person — worth saying explicitly
        // here, since it is the one thing an in-person (Nearby) payer never
        // has to wonder about (ux §4.2/§8 "Success / arrival").
        statusNote: t('pay_sent_handed_to_wallet')
      })
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
        satoshis: sats,
        note
      })
      setSent({ amount: paidSatoshis, recipient: to.address })
    },
    [wallet, adminOriginator, note, t]
  )

  /**
   * The token send. One call, because the runtime owns the whole pipeline —
   * coin selection, the blinded lock, the noSend build, the overlay submit, the
   * journal and the abort on refusal. What this screen owns is the sentence the
   * holder reads afterwards, and the rule that a refusal is the only outcome
   * allowed to promise "nothing was sent".
   */
  const sendToken = useCallback(
    async (to: Extract<RecipientTarget, { kind: 'handle' }>, baseUnits: number): Promise<boolean> => {
      const runtime = mandala.runtime
      if (!runtime || !asset) throw new Error(t('wallet_not_ready'))
      const ctx = {
        ticker: asset.ticker,
        issuer: asset.issuerName,
        issuerFallback: t('token_issuer_fallback'),
        reasonFallback: t('token_err_reason_unknown')
      }
      const result = await runtime.sendToHandle({
        assetId: asset.assetId,
        recipientIdentityKey: to.identityKey,
        baseUnits,
        ...(note.trim() ? { note: note.trim() } : {})
      })
      if (result.kind !== 'sent') {
        // The banner narrows the reason to one sentence; the console keeps the
        // whole of it. On a rail that contacts nothing at send time, the raw
        // message IS the diagnosis (a MessageBox that would not open, a wallet
        // that could not sign) and is the only place it survives.
        console.warn('[pay] token send failed:', result.kind, result.message ?? (result as { code?: string }).code)
        setTokenFailure(tokenSendCopy(result, ctx))
        // A refusal must leave the review step exactly as it is — the banner
        // that explains it lives there, and stepping back to "who" (as a
        // successful send does) would carry the user straight past it.
        return false
      }
      setSent({
        amount: 0,
        recipient: recipient.selectedIdentity?.name,
        recipientIdentityKey: to.identityKey,
        // Never falls back to the satoshi renderer: a token figure it could not
        // format would print as satoshis, which is a wrong number rather than a
        // missing one.
        amountText: formatTokenAmountWithUnit(baseUnits, asset) ?? t('token_row_amount_pending'),
        // `notified === false` takes priority: the money moved either way, but
        // the recipient has not been TOLD it did (the lib's own notify retries
        // in the background — see `TokenSendResult.notified`), and that is the
        // more useful thing to tell the payer, whether or not the coin is
        // settled yet.
        //
        // Otherwise the handle rail now says SETTLING, not "not broadcast": a
        // hand-over send never asked the overlay anything (§4.5 / wire §9.13),
        // so the honest sentence is that the payment is made and is on its way
        // to the issuer — which is exactly what the nearby rail has always
        // said, and the same pair of keys says it. `settled` is kept ahead of
        // it because it remains the runtime's own word for σ_I in hand, and a
        // rail that one day hands one back must not be told to under-claim.
        statusNote: !result.notified
          ? t('pay_sent_not_notified')
          : result.settled
            ? t('token_sent_settled', { issuer })
            : recipient.selectedIdentity?.name
              ? t('token_sent_settling', { issuer, payee: recipient.selectedIdentity.name })
              : t('token_sent_settling_unnamed', { issuer })
      })
      mandala.refresh()
      return true
    },
    [mandala, asset, issuer, recipient.selectedIdentity, note, t]
  )

  const handleSend = useCallback(async () => {
    // XR-061: isSending is React state and does not commit synchronously, so
    // two activations landing in the same JS turn (a double-tap, or two
    // gesture callbacks firing before the disabled prop reaches the native
    // view) would both pass every guard below and independently reach a
    // value-moving rail call. This ref is checked and set synchronously,
    // before any await, so the second activation returns immediately; it is
    // released in the same `finally` that clears `isSending`.
    if (sendingRef.current) return
    sendingRef.current = true
    try {
      if (!target) return
      // Guard before any side effect: a wallet that is not ready must leave the
      // form exactly as typed, with a banner, not a cleared field and silence.
      // On the token path the runtime IS the wallet — it holds its own manager,
      // storage and journal — so that is what has to be ready.
      if (asset ? !mandala.runtime : !wallet || !storage) {
        flashResult({ type: 'error', message: t('wallet_not_ready') })
        return
      }
      // The same integer either way — satoshis on the BSV rail, base units of the
      // asset on the token rail. The field emits whole units in both modes.
      const amount = Math.round(Number(sendAmount))
      if (!Number.isFinite(amount) || amount <= 0) {
        flashResult({ type: 'error', message: t('enter_valid_amount') })
        return
      }
      haptics.confirm()
      setIsSending(true)
      setTokenFailure(null)
      try {
        if (asset) {
          // D4: a token has no address rail, and `canSend` has already refused
          // one. This is the second gate, because the first is a render.
          if (target.kind !== 'handle') return
          const sent = await sendToken(target, amount)
          if (!sent) return
        } else if (target.kind === 'handle') await sendHandle(target, amount)
        else await sendAddress(target, amount)
        setFigure(current => ({ ...current, text: '' }))
        setNote('')
        recipient.clearRecipient()
        setStep('who')
      } catch (error: any) {
        if (await handleWalletCheck(error)) return
        if (asset) {
          console.warn('[mandala] token send threw:', error)
          // A throw out of the token path is NOT a refusal: the overlay may have
          // admitted the transaction and lost the response, so the copy claims
          // nothing and offers a balance check rather than a retry.
          setTokenFailure(
            tokenThrowCopy(error, {
              ticker: asset.ticker,
              issuer: asset.issuerName,
              issuerFallback: t('token_issuer_fallback')
            })
          )
          return
        }
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
    } finally {
      sendingRef.current = false
    }
  }, [
    target,
    sendAmount,
    asset,
    sendToken,
    sendHandle,
    sendAddress,
    recipient,
    handleWalletCheck,
    flashResult,
    loadOutbox,
    mandala.runtime,
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
        setSent({ amount: entry.token.amount, recipientIdentityKey: entry.recipient })
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
  /**
   * misc-p2-03: the address rail pays with a P2PKH lock regardless of which
   * network's version byte the pasted/scanned address carries — the same key
   * redeems on either chain, so this is a warning, not a refusal. Recomputed
   * from the address itself rather than threaded through `target`, so the
   * check stays independent of how the recipient was resolved (typed, scanned
   * or picked from a search result).
   */
  const detectedAddressNetwork = target?.kind === 'address' ? addressNetwork(target.address) : undefined
  const addressNetworkMismatch =
    !!detectedAddressNetwork && detectedAddressNetwork !== (selectedNetwork === 'main' ? 'main' : 'test')
  // A stuck handle payment blocks new HANDLE sends: every attempt while the box
  // is unreachable would mint another noSend action and another stuck entry.
  // Address sends never touch the box, so they are not held hostage by it.
  const handleBlockedByOutbox = isHandle && outbox.length > 0
  const handleFormValid = isHandle && amountOk && !isSending && isConfigured

  // ── token pre-flight ────────────────────────────────────────────────
  // Advisory, and it may only ever say "no". Nothing here promises a send will
  // work; `resolveAssetState` and the registry both fail open, so a pre-flight
  // that said "this will work" would be the one claim they cannot support.
  const baseUnits = asset ? Math.round(Number(sendAmount)) || 0 : 0
  const overBalance = !!holding && baseUnits > holding.baseUnits
  /**
   * The runtime's plain reason this recipient cannot be paid in this asset —
   * an address (D4), an unregistered identity, a blocked one.
   *
   * Asked only once the field has RESOLVED to something. Half-typed text is not
   * a recipient, and answering "no" to it would put a refusal on screen for a
   * name the user is still in the middle of writing.
   */
  const recipientRefusal =
    asset && mandala.runtime && target
      ? mandala.runtime.recipientRefusal(target.kind === 'handle' ? target.identityKey : target.address)
      : null
  const tokenAddressRefused = !!asset && isAddress
  // Every one of these is a KNOWN-false fact, never an unknown one: `assetStatus`
  // is `null` until the first read lands and fails open on every later read, so
  // `=== true`/`=== false` (never a bare truthiness check) is what keeps a cold
  // read or an unreachable overlay from disabling the button on a guess.
  const paused = assetStatus?.paused === true
  const unidentified = assetStatus?.metadataResolved === false
  const selfUnregistered = assetStatus?.selfAdmitted === false
  // Only asked once the recipient resolved to a handle — an address is already
  // refused by D4 above, and half-typed text is not a recipient yet.
  const recipientRegistryRefused = !!asset && target?.kind === 'handle' && recipientAdmitted === false
  const frozenBaseUnits = assetStatus?.frozenBaseUnits ?? 0
  const tokenFormValid =
    !!asset &&
    isHandle &&
    amountOk &&
    !isSending &&
    !overBalance &&
    !recipientRefusal &&
    !tokenAddressRefused &&
    !paused &&
    !unidentified &&
    !selfUnregistered &&
    !recipientRegistryRefused

  const canSend = asset
    ? tokenFormValid
    : isAddress
      ? amountOk && !isSending
      : handleFormValid && !handleBlockedByOutbox

  /**
   * At most one note, in this order — the same order as ux design §4.2's
   * pre-flight table: the reasons that block the CTA first (most specific
   * first), then the two that are advisory only (frozen, needs-BSV) and never
   * disable it. The BSV-fee note stays last and — this is the part that
   * matters — it NEVER disables the button: `useSpendableBalance()` returns
   * `null` on a cold open, `null < n` is `true` in JavaScript, and the
   * authoritative answer is the toolbox's own funding throw, which comes back
   * as the same sentence.
   */
  const tokenNote: {
    key: string
    values?: Record<string, string>
    /** The runtime's own sentence, which wins over the key when it has one. */
    text?: string
    action?: 'get-bsv'
  } | null = asset
    ? tokenAddressRefused
      ? // D4, stated plainly. The runtime's own reason wins when it has one:
        // it knows which of the several reasons an address cannot be paid
        // applies, and a specific true sentence beats a general true sentence.
        { key: 'pay_asset_no_address', values: { ticker: asset.ticker }, text: recipientRefusal ?? undefined }
      : paused
        ? { key: 'pay_asset_paused', values: { issuer, ticker: asset.ticker } }
        : unidentified
          ? { key: 'pay_asset_unidentified' }
          : selfUnregistered
            ? { key: 'pay_asset_self_unregistered', values: { issuer, ticker: asset.ticker } }
            : recipientRegistryRefused
              ? // The runtime's registry only answers a yes/no boolean, not WHY —
                // `accessMode` says which gate refused: a denylist hit is a block,
                // anything else (an allowlist gate, or none reported) reads as
                // "not registered yet", which is the truer default of the two.
                {
                  key:
                    assetStatus?.accessMode === 'denylist'
                      ? 'pay_asset_recipient_blocked'
                      : 'pay_asset_recipient_unregistered',
                  values: { issuer, ticker: asset.ticker }
                }
              : overBalance
                ? { key: 'pay_asset_over_balance', values: { ticker: asset.ticker } }
                : frozenBaseUnits > 0
                  ? {
                      key: 'pay_asset_frozen_note',
                      values: { ticker: asset.ticker, amount: formatTokenAmount(frozenBaseUnits, asset.decimals) ?? '' }
                    }
                  : spendableSats === 0
                    ? { key: 'pay_asset_needs_bsv', values: { ticker: asset.ticker }, action: 'get-bsv' }
                    : null
    : null

  const backStep = useCallback(() => {
    setStep(prev => (prev === 'review' ? 'amount' : 'who'))
  }, [])
  useImperativeHandle(
    ref,
    () => ({
      back: () => {
        if (step === 'who') return false
        backStep()
        return true
      }
    }),
    [step, backStep]
  )
  // Taken off `recipient` here rather than called through it below: calling it
  // as a method would make the whole (rebuilt every render) `recipient` object
  // a dependency of the effect, and an effect that reran every render would
  // clear the overlay's own search notice the instant it was raised.
  const clearSearchError = recipient.clearSearchError
  useEffect(() => {
    onStepChange?.(step)
    // Neither search notice belongs on the amount or review screen: both are
    // about a recipient field that is no longer on screen.
    setRegistryError(false)
    clearSearchError()
  }, [step, onStepChange, clearSearchError])

  // ── the review card's facts ──────────────────────────────────────────
  // Once money is moving, the figure is ALWAYS the asset that actually moves
  // (BSV or the token), never the display currency (2026-09-17 ruling):
  // "12.00 USD" on a BSV send reads as a stablecoin.
  const sendSats = Math.round(Number(sendAmount)) || 0
  const reviewAmount = asset
    ? { value: formatTokenAmount(baseUnits, asset.decimals) ?? '', unit: asset.ticker }
    : { value: formatSatoshisAsBsvDecimal(sendSats), unit: 'BSV' }
  const reviewPrimary =
    recipient.selectedIdentity?.name ||
    (target?.kind === 'handle' ? abbreviateKey(target.identityKey) : target?.kind === 'address' ? target.address : '')
  // The handle the picked row carried, when it is still the row being paid —
  // the name above it may be anything its owner published, this is the address
  // the money is going to. An abbreviated key only when there is no handle.
  const reviewSecondary =
    recipient.selectedIdentity?.name && target?.kind === 'handle'
      ? pickedHandle?.identityKey === target.identityKey
        ? pickedHandle.handle
        : abbreviateKey(target.identityKey)
      : undefined
  const reviewTrust = targetIsContact
    ? { icon: 'person-circle-outline', color: colors.textSecondary, text: t('pay_trust_contact') }
    : recipient.selectedIdentity
      ? { icon: 'shield-checkmark-outline', color: colors.textSecondary, text: t('pay_trust_handle_attested') }
      : { icon: 'alert-circle-outline', color: colors.warning, text: t('pay_trust_unverified') }
  const showNoteRow = isHandle || (isAddress && !asset)

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <StepBar step={step} />
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}
      {/* One notice for both remote tiers. Offline they fail on the same
          keystroke, and two banners carrying the identical sentence read as the
          error re-appearing when the first is dismissed. */}
      {(recipient.searchError || registryError) && (
        <ResultBanner
          result={{ type: 'error', message: t('identity_search_unavailable') }}
          onDismiss={() => {
            recipient.clearSearchError()
            setRegistryError(false)
          }}
          colors={colors}
        />
      )}

      {step === 'who' && (
        <>
          <PayField labelKey="pay_review_to">
            <RecipientField
              selectedIdentity={recipient.selectedIdentity}
              inputText={recipient.inputText}
              target={recipient.target}
              inlineError={recipient.inlineError}
              isSearching={recipient.isSearching || registrySearching}
              searchResults={mergedSearchResults}
              colors={colors}
              t={t}
              onChangeText={recipient.onChangeText}
              onSelectIdentity={onSelectIdentity}
              onClear={onClearRecipient}
              onOpenScanner={recipient.openScanner}
              assetTicker={asset?.ticker}
              recentLabel={t('contacts_recent')}
              statusOverride={
                recipientRefusal && !tokenAddressRefused
                  ? { text: recipientRefusal, tone: 'warning' }
                  : recipientRegistryRefused
                    ? {
                        text: t(
                          assetStatus?.accessMode === 'denylist'
                            ? 'pay_asset_recipient_blocked'
                            : 'pay_asset_recipient_unregistered',
                          { issuer, ticker: asset?.ticker }
                        ),
                        tone: 'warning'
                      }
                    : undefined
              }
            />
          </PayField>

          {/* No "Paying with" picker here (design 1b, 2026-09-15): the coin is
              chosen once, on Home's switcher, and arrives as `selectedAssetId`. */}

          {target ? (
            <PayCta
              onPress={() => setStep('amount')}
              disabled={false}
              busy={false}
              label={t('pay_step_continue')}
              icon="arrow-forward"
            />
          ) : (
            <PressableScale
              onPress={() => loadExpoRouter().router.push('/contacts' as never)}
              haptic="tap"
              style={[
                styles.outlineBtn,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
              ]}
              accessibilityRole="button"
            >
              <Ionicons name="people-outline" size={18} color={colors.textPrimary} />
              <Text style={[styles.outlineBtnText, { color: colors.textPrimary }]}>{t('pay_step_contacts')}</Text>
            </PressableScale>
          )}

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
        </>
      )}

      {step === 'amount' && (
        <>
          <PayAmountField
            value={sendAmount}
            onChangeText={setSendAmount}
            asset={asset ? { ticker: asset.ticker, decimals: asset.decimals } : undefined}
            maxValue={holding ? String(holding.baseUnits) : undefined}
            availableText={
              holding ? (formatTokenAmount(holding.baseUnits, holding.asset.decimals) ?? undefined) : undefined
            }
          />

          <PayCta
            onPress={() => setStep('review')}
            disabled={!amountOk}
            busy={false}
            label={t('pay_step_continue')}
            icon="arrow-forward"
          />
        </>
      )}

      {step === 'review' && target && (
        <>
          <View
            style={[styles.reviewCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
          >
            <View style={[styles.reviewRow, { borderBottomColor: colors.separator }]}>
              <Text style={[styles.reviewLabel, { color: colors.textTertiary }]}>{t('pay_review_to')}</Text>
              {target.kind === 'handle' ? (
                <ContactSigil
                  identityKey={target.identityKey}
                  avatarUrl={recipient.selectedIdentity?.avatarURL || undefined}
                  size={32}
                  radius={16}
                />
              ) : (
                <View style={[styles.reviewAddressIcon, { backgroundColor: colors.fillTertiary }]}>
                  <Ionicons name="wallet-outline" size={16} color={colors.textSecondary} />
                </View>
              )}
              <View style={styles.reviewToText}>
                <View style={styles.reviewNameRow}>
                  <Text style={[styles.reviewName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {reviewPrimary}
                  </Text>
                  {!!reviewSecondary && (
                    <Text
                      style={[styles.reviewNameSub, { color: colors.textSecondary }]}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {reviewSecondary}
                    </Text>
                  )}
                </View>
                {target.kind === 'handle' && (
                  <View style={styles.reviewTrustRow}>
                    <Ionicons name={reviewTrust.icon as never} size={12} color={reviewTrust.color} />
                    <Text style={[styles.reviewTrust, { color: reviewTrust.color }]} numberOfLines={1}>
                      {reviewTrust.text}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            <View
              style={[styles.reviewRow, !showNoteRow && styles.reviewRowLast, { borderBottomColor: colors.separator }]}
            >
              <Text style={[styles.reviewLabel, { color: colors.textTertiary }]}>{t('pay_review_amount')}</Text>
              {/* No adjustsFontSizeToFit / numberOfLines: iOS's shrink floor is a fixed 4pt and in this
                  flex row it collapsed the amount to illegible. A long amount wraps instead, so no digit
                  is ever hidden on the screen that confirms it. */}
              <Text
                style={[styles.reviewAmount, { color: colors.textPrimary }]}
                accessibilityLabel={`${reviewAmount.value} ${reviewAmount.unit}`}
              >
                {reviewAmount.value}{' '}
                <Text style={[styles.reviewUnit, { color: colors.textSecondary }]}>{reviewAmount.unit}</Text>
              </Text>
            </View>

            {showNoteRow && (
              <View style={[styles.reviewRow, styles.reviewRowLast]}>
                <Text style={[styles.reviewLabel, { color: colors.textTertiary }]}>{t('pay_review_note')}</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder={t('pay_review_note_edit')}
                  placeholderTextColor={colors.textQuaternary}
                  maxLength={280}
                  style={[styles.reviewNoteInput, { color: colors.textPrimary }]}
                />
                <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
              </View>
            )}
          </View>

          {/* Load-bearing for an address: this rail cannot notify the payee. Nothing
              for a handle, and nothing at all in token mode, where an address is
              refused rather than warned about. */}
          {isAddress && !asset && <ConsequenceNote textKey={CONSEQUENCE_KEYS.address} />}
          {isAddress && !asset && addressNetworkMismatch && <ConsequenceNote textKey="pay_address_network_mismatch" />}

          {tokenNote && (
            <ConsequenceNote
              textKey={tokenNote.key}
              values={tokenNote.values}
              text={tokenNote.text}
              action={
                tokenNote.action === 'get-bsv'
                  ? {
                      label: t('pay_asset_get_bsv'),
                      onPress: () => loadExpoRouter().router.push('/pay?direction=get' as never)
                    }
                  : undefined
              }
            />
          )}

          {isHandle && !isConfigured && !asset && (
            <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('message_box_off_hint')}</Text>
          )}
          {handleFormValid && handleBlockedByOutbox && !asset && (
            <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t('finish_or_cancel_outgoing')}</Text>
          )}

          <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} labelKey="send" />

          {/* A failed token send, in the app's own failure channel: error tone,
              dismissible, and carrying at most one affordance. "Check again"
              refreshes the balance rather than re-sending, because a retry after a
              lost response builds a second spend of the same coins. */}
          {tokenFailure && (
            <ResultBanner
              result={{ type: 'error', message: t(tokenFailure.key, tokenFailure.values) }}
              onDismiss={() => setTokenFailure(null)}
              colors={colors}
              action={
                tokenFailure.action === 'check-again'
                  ? {
                      label: t('token_err_check_again'),
                      onPress: () => {
                        mandala.refresh()
                        setTokenFailure(null)
                      }
                    }
                  : tokenFailure.action === 'get-bsv'
                    ? {
                        label: t('pay_asset_get_bsv'),
                        onPress: () => loadExpoRouter().router.push('/pay?direction=get' as never)
                      }
                    : undefined
              }
            />
          )}
        </>
      )}

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

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
          amountText={sent.amountText}
          statusNote={sent.statusNote}
          recipientName={sent.recipient}
          onAddContact={offerAddContact ? onAddContact : undefined}
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

  // Step 1's quiet second door: Contacts, on the chrome surface.
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  outlineBtnText: { ...typography.subhead, fontWeight: '600' },

  // Review card (step "review"): label-left rows, hairlines between them.
  reviewCard: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden'
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  reviewRowLast: { borderBottomWidth: 0 },
  reviewLabel: {
    width: 64,
    ...typography.caption2,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase'
  },
  reviewAddressIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  reviewToText: { flex: 1, minWidth: 0, gap: 2 },
  reviewNameRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, minWidth: 0 },
  reviewName: { ...typography.body, fontWeight: '600', flexShrink: 1 },
  reviewNameSub: { ...typography.subhead, flexShrink: 1 },
  reviewTrustRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  reviewTrust: { ...typography.caption1 },
  reviewAmount: { ...typography.title2, fontWeight: '700', fontVariant: ['tabular-nums'], flex: 1 },
  reviewUnit: { ...typography.headline, fontWeight: '600' },
  reviewNoteInput: { ...typography.body, flex: 1, minWidth: 0, paddingVertical: 0 },

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

const UniversalSend = forwardRef<UniversalSendHandle, UniversalSendProps>(UniversalSendInner)

// Wallet status updates in the parent do not change this form's inputs.
export default memo(UniversalSend)
