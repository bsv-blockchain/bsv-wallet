/**
 * The Wallet screen — full screen, not a drawer.
 *
 * Structure, top to bottom:
 *   balance  →  Pay / Get paid / Vault  →  activity, grouped by day
 *
 * This replaces a bottom-sheet settings menu plus a separate Transactions
 * route. Activity now sits on the screen the user already opens to check their
 * money, so "did that payment go through?" costs one tap instead of two.
 *
 * Colour discipline: `colors.accent` is achromatic (black/white) in this token
 * set, so it only reads as emphasis when used as a FILL. Exactly one element
 * here is accent-filled — Pay — and chroma elsewhere is reserved for
 * transaction status, never for decoration.
 *
 * Surfaces come from the `canvas*`/`surface*` tokens rather than the iOS grays:
 * the screen is a shallow gradient with cards lifted off it, which is what makes
 * the balance read as the focal point in both appearances.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo, useContext, useDeferredValue } from 'react'
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  type ListRenderItem
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Utils } from '@bsv/sdk'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { PeerPayClient } from '@bsv/message-box-client'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  ExchangeRateContext,
  formatAmountParts,
  isFiatCurrency,
  findOfflineActions,
  type OfflineActionRow,
  TaskSendOffline,
  TaskCreditInbox,
  readWalletBalance,
  useLocalStorage,
  handleResendRequests,
  listPendingResendRequests,
  loadUnansweredResends,
  resendPaymentDetails,
  makeListPeerPayAction,
  makeBeefRepair,
  makeResendBeef,
  wocConfigFor,
  getOnline,
  haptics,
  DEFAULT_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  LEGACY_MESSAGE_BOX_URL,
  getOutboxEntries,
  unsentEntries,
  retryDelivery,
  makePeerPayClient,
  isMessageBoxNetworkError,
  generateMnemonicWallet,
  backupAttestation,
  isVaultAvailable,
  type PendingResend
} from '@bsv/expo-wallet-toolbox'
import ActivityRow, { type ActivityAction } from '../components/wallet/ActivityRow'
import { FitAmount } from '../components/wallet/FitAmount'
import SlideOverFromRight from '../components/ui/SlideOverFromRight'
import TransactionDetailScreen, {
  type TransactionAction,
  type TransactionDetailParams
} from './TransactionDetailScreen'
import { useContactsStore } from '../hooks/useContactsStore'
import { BackupReminderSheet } from '../components/wallet/BackupReminderSheet'
import { BiometricAdvisoryModal } from '../components/wallet/BiometricAdvisoryModal'
import { ImportFromBackupPrompt } from '../components/wallet/ImportFromBackupPrompt'
import { cancelParkedPayment, type CancelParkedWallet } from '../../core/offline/cancelParked'
import { releaseParkedPayment } from '../../core/offline/payerHold'
import { partitionQueueByGrace } from '../../core/offline/queueGrace'
import { storageMatchesNetwork } from '../../core/net/chainMatch'
import { makeMetadataDecryptor } from '../../core/peerpay/metadataDecryptor'
import { getPendingCorruptNotice, readUnprocessedPending } from '../../core/localpay/pending'
import { homeBadges } from './homeBadges'
import { tokenRowTitle } from './tokenRowTitle'
import { useMandala, useMandalaRuntime, useTokenActivity, tokenActivityByTxid } from '../hooks/useMandala'
import { announceEviction, evictionsFrom } from '../components/wallet/tokenEviction'
import { SEEN_EVICTIONS_KEY, useSeenSet } from '../tokenSeen'
import { tokenRowStatusView } from '../tokenStatus'
import { formatTokenAmount, tokenAmountParts } from '../tokenFormat'
import AssetSwitcherDropdown, { BSV_LABEL } from '../components/wallet/AssetSwitcherDropdown'
import { exportTransactionsAsCsv } from '../exportTransactions'
import {
  ACTIVITY_KIND_FILTERS,
  contactNamesByKey,
  isActivityFilterActive,
  kindFilterLabelKey,
  matchesActivity,
  searchTerms,
  type ActivityKindFilter,
  type ContactNames
} from '../activityFilter'
import PressableScale from '../components/ui/PressableScale'
import ScreenGradient from '../components/ui/ScreenGradient'
import ScrollFade, { sampleScreenGradient } from '../components/ui/ScrollFade'
import { showToast } from '../components/ui/Toast'
import { ListRow } from '../components/ui/ListRow'
import { GroupedSection } from '../components/ui/GroupedList'
import WalletLockNotice from '../components/security/WalletLockNotice'
import OfflineNotice from '../components/pay/OfflineNotice'
import { useOnline } from '../hooks/useOnline'
import { useOfflineNoticeActions } from '../hooks/useOfflineNoticeActions'

async function readMessageBoxUrl(): Promise<string | undefined> {
  const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
  if (saved === NO_MESSAGE_BOX) return undefined
  if (!saved || saved === LEGACY_MESSAGE_BOX_URL) return DEFAULT_MESSAGE_BOX_URL
  return saved
}

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Both icon sets are loaded lazily, only when actually rendering, same
 * pattern as this package's other native-module-boundary fixes (expo-router,
 * expo-blur).
 */
/**
 * Demo mode, or inert constants in anything but a dev bundle.
 *
 * Required at module scope behind `__DEV__` so the demo folder reaches only a
 * dev bundle — a release build inlines `__DEV__` as false and folds the
 * require and everything under it out. Same pattern as
 * `utils/AgentationGate.tsx`. `useDemoLedgerVersion` is a hook, so it is
 * called unconditionally below and its identity must never change.
 */
type DemoModule = typeof import('../../core/demo')
const demoMod: DemoModule | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../../core/demo') as DemoModule)
  : null
const useDemoLedgerVersion: () => number = demoMod ? demoMod.useDemoLedgerVersion : () => 0

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
    materialCommunityIconsComponent = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@expo/vector-icons').MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's and components/security/WalletLockNotice.tsx's
 * lazy expo-router load. `useFocusEffect` is a hook, but calling it via
 * `loadExpoRouter().useFocusEffect(...)` is equivalent to calling it directly
 * — the module is cached after the first call, so it is the exact same
 * function reference on every render, which is what the rules of hooks
 * actually require (a stable, unconditional call per render), not the manner
 * in which the reference to that function was obtained.
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

const PAGE_SIZE = 30

/** A day heading injected between rows. Kept in the same list as the rows so
 * the whole thing stays one FlatList — a SectionList would re-measure every
 * section on each status poll. */
type DayHeader = { kind: 'day'; id: string; label: string }
/**
 * Statuses whose transaction is still local and therefore abortable — the same
 * set `ActivityRow` gates its own Cancel chip on. Duplicated as a constant
 * rather than imported so the row keeps owning its own copy while both
 * surfaces exist.
 */
const ABORTABLE_DETAIL_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

type Row = DayHeader | (ActivityAction & { kind?: undefined })

const DAY_MS = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Group rows under Today / Yesterday / an absolute date. Rows with no
 * timestamp fall through ungrouped rather than being dated wrongly. */
function withDayHeaders(actions: ActivityAction[], t: (k: string) => string): Row[] {
  const today = startOfDay(new Date())
  const out: Row[] = []
  let currentDay: number | null = null
  for (const action of actions) {
    const raw = action.created_at
    const ts = raw === undefined || raw === null ? NaN : new Date(raw as string).getTime()
    if (!Number.isNaN(ts)) {
      const day = startOfDay(new Date(ts))
      if (day !== currentDay) {
        currentDay = day
        const label =
          day === today
            ? t('wallet_group_today')
            : day === today - DAY_MS
              ? t('wallet_group_yesterday')
              : new Date(day).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: day < today - 300 * DAY_MS ? 'numeric' : undefined
                })
        out.push({ kind: 'day', id: `day-${day}`, label })
      }
    }
    out.push(action)
  }
  return out
}

export interface WalletHomeScreenProps {
  /**
   * Rendered in the top-left of the header — e.g. a back button for host apps
   * that present the wallet as a screen within a larger flow (BSV Browser).
   * No default: most hosts (BSV Wallet included) have nothing to return to.
   */
  topLeft?: React.ReactNode
}

export function WalletHomeScreen({ topLeft }: WalletHomeScreenProps = {}) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router, useFocusEffect } = loadExpoRouter()
  const Ionicons = loadIonicons()
  // Repaints the screen on every demo write; 0 and no-op in a release bundle.
  useDemoLedgerVersion()
  const demoOn = demoMod?.isDemoModeEnabled() ?? false
  const MaterialCommunityIcons = loadMaterialCommunityIcons()
  const {
    managers,
    adminOriginator,
    selectedNetwork,
    storage,
    txStatusVersion,
    walletUserId,
    refreshProof,
    settings,
    walletBuilt,
    walletBuilding,
    buildWalletFromMnemonic,
    mandalaSettlement
  } = useWallet()
  const { createMnemonic, hasStoredIdentity, secretsReady } = useLocalStorage()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'
  /**
   * Tapping the balance flips which denomination the hero figure is in.
   *
   * View state, not a setting: the display-currency setting chooses WHICH
   * fiat this wallet speaks, and a tap on the figure should not silently
   * rewrite a stored preference that also governs every activity row. Resets
   * to the setting's own answer on relaunch.
   */
  const [flipped, setFlipped] = useState(false)
  /** The row whose detail view is open, or null. Holds the ACTION, so the
   * detail view keeps drawing the row it was opened from even if a refresh
   * reorders the list underneath it. */
  const [openTx, setOpenTx] = useState<ActivityAction | null>(null)
  /** The row still being drawn while the detail view slides back out. */
  const [closedTx, setClosedTx] = useState<ActivityAction | null>(null)
  // Render-phase adjustment rather than an effect: the outgoing surface must
  // already have its content on the frame the close starts.
  if (openTx && openTx !== closedTx) setClosedTx(openTx)
  /** The setting's opposite: BSV when it names a fiat, else the default fiat. */
  const displayCurrency = useMemo(() => {
    if (!flipped) return currency
    return isFiatCurrency(currency) ? 'BSV' : 'USD'
  }, [flipped, currency])
  // Built once here and passed down to every row (with `walletUserId`) so an
  // expanded row's tappable-contact check never has to call `useWallet()`
  // itself — the whole reason `ActivityRow` takes `currency` as a prop too.
  const contactsStore = useContactsStore()
  const online = useOnline()
  // For the token Resend below. Read here rather than off `useMandala()` (which
  // mounts further down) so the handler can close over it without a
  // use-before-declaration.
  const mandalaRuntime = useMandalaRuntime()

  // ── lazy wallet creation ────────────────────────────────────────────
  /**
   * Apple HIG: never ask for Face ID/Touch ID before the user has done
   * something that explains why. Creating a wallet needs biometric-gated
   * storage (createMnemonic below), so building one eagerly on first mount —
   * as this screen used to — put a biometric prompt in front of a user who
   * had not yet tapped anything. Instead, wallet creation is deferred until
   * the first Pay or Get Paid tap (see destinationPress below), behind a
   * one-time advisory modal that explains the prompt before it fires.
   *
   * A fresh install has no mnemonic and no recovered key, so until that
   * first tap this screen simply renders with no wallet: zero balance, no
   * activity, Pay/Get Paid still visible. WalletLockNotice covers a
   * RETURNING user whose key the OS destroyed or who cancelled the
   * biometric prompt ('lost' / 'cancelled' / 'unavailable'); a true fresh
   * install never reaches those states, so nothing else needs to render
   * here in the meantime.
   */
  const creatingWalletRef = useRef(false)
  const ensureWalletExists = useCallback(async (): Promise<boolean> => {
    if (managers.permissionsManager) return true
    if (!secretsReady || walletBuilding || creatingWalletRef.current) return false
    creatingWalletRef.current = true
    try {
      // A missing manager during migration, unlock, or a failed build does
      // not mean the device has no wallet. Never replace that stored identity.
      if (await hasStoredIdentity()) return false
      const wallet = generateMnemonicWallet()
      const stored = await createMnemonic(wallet.mnemonic)
      if (!stored) {
        // Biometric access was needed and unavailable/declined — same dead
        // end onboarding's own generate flow hits. Send the user there to
        // retry explicitly rather than silently failing the tap.
        if (!(await hasStoredIdentity())) router.replace('/auth/mnemonic')
        return false
      }
      try {
        await backupAttestation.markPending(wallet.identityKey)
      } catch (error) {
        console.warn('[WalletHome] Could not record pending backup reminder:', error)
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      return true
    } catch (error) {
      console.warn('[WalletHome] Wallet creation did not complete:', error)
      return false
    } finally {
      creatingWalletRef.current = false
    }
  }, [
    managers.permissionsManager,
    secretsReady,
    walletBuilding,
    hasStoredIdentity,
    createMnemonic,
    buildWalletFromMnemonic,
    router
  ])

  const [pendingDestination, setPendingDestination] = useState<string | null>(null)
  const [showBiometricAdvisory, setShowBiometricAdvisory] = useState(false)
  const [creatingWalletFromAdvisory, setCreatingWalletFromAdvisory] = useState(false)

  const destinationPress = useCallback(
    async (destination: string) => {
      if (managers.permissionsManager) {
        router.push(destination as Parameters<typeof router.push>[0])
        return
      }
      if (!secretsReady || walletBuilding) return
      try {
        if (await hasStoredIdentity()) return
      } catch {
        return
      }
      setPendingDestination(destination)
      setShowBiometricAdvisory(true)
    },
    [managers.permissionsManager, secretsReady, walletBuilding, hasStoredIdentity, router]
  )

  // ── backup reminder ─────────────────────────────────────────────────
  /**
   * Remind only identities created with an explicit pending-backup record.
   * Older wallets without tracking have unknown status. Re-check on focus so
   * dismissing the card never sticks for the session — it reappears the
   * moment the user lands back on the main page, until they actually back
   * up or import. Same advisory attestation the vault gate reads.
   */
  const [showBackupReminder, setShowBackupReminder] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setShowBackupReminder(false)
      if (!walletBuilt) return
      const wallet = managers.permissionsManager
      if (!wallet) return
      let cancelled = false
      ;(async () => {
        try {
          const { publicKey } = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
          const needsReminder = await backupAttestation.needsReminder(publicKey)
          if (!cancelled) setShowBackupReminder(needsReminder)
        } catch {
          // An unavailable status is not proof that the wallet is unbacked.
          if (!cancelled) setShowBackupReminder(false)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [walletBuilt, managers.permissionsManager, adminOriginator])
  )

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  /**
   * Whether what is mounted is this network's wallet.
   *
   * A switch tears the wallet down and rebuilds it; until that finishes there
   * is either no storage or the old chain's. Reading either one is how a
   * testnet wallet came to show a mainnet balance and a mainnet activity list.
   */
  const onThisNetwork = storageMatchesNetwork(storage, selectedNetwork)
  const [balance, setBalance] = useState<number | null>(null)
  const [actions, setActions] = useState<ActivityAction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  // ── activity filter ──────────────────────────────────────────────────
  /**
   * The filter lives only while its panel is open: closing it puts every row
   * back, so a closed panel can never be the reason a payment is missing.
   */
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterKind, setFilterKind] = useState<ActivityKindFilter>('all')
  // Typing stays responsive on a long history: the list catches up a beat
  // behind the keystroke instead of every keystroke waiting on the list.
  const deferredQuery = useDeferredValue(filterQuery)
  const activityFilter = useMemo(
    () => ({ kind: filterKind, terms: searchTerms(deferredQuery) }),
    [filterKind, deferredQuery]
  )
  const filterActive = isActivityFilterActive(activityFilter)
  const toggleFilter = useCallback(() => {
    setFilterOpen(open => !open)
    setFilterQuery('')
    setFilterKind('all')
  }, [])
  /** Saved contacts' names and handles, so a search can name who a row was with. */
  const [contactNames, setContactNames] = useState<ReadonlyMap<string, ContactNames>>(new Map())
  // Re-read on every open: a contact saved or renamed since the last search
  // should be findable by the name it has now.
  useEffect(() => {
    if (!filterOpen || !contactsStore || walletUserId == null) return
    let cancelled = false
    contactsStore.listContacts(walletUserId).then(
      contacts => {
        if (!cancelled) setContactNames(contactNamesByKey(contacts))
      },
      () => {
        // A search that cannot name contacts still searches every note.
      }
    )
    return () => {
      cancelled = true
    }
  }, [filterOpen, contactsStore, walletUserId])
  const [offlineByTxid, setOfflineByTxid] = useState<Map<string, OfflineActionRow>>(new Map())
  /** What the row's spinner is currently waiting on. */
  const [busyLabel, setBusyLabel] = useState<string | undefined>(undefined)
  /** Bumped when a queued payment outlives its grace, so the banner can appear. */
  const [graceNonce, setGraceNonce] = useState(0)
  const [attentionCount, setAttentionCount] = useState(0)
  const [unsentCount, setUnsentCount] = useState(0)
  const [stalled, setStalled] = useState<string | undefined>(undefined)
  const [pendingCount, setPendingCount] = useState(0)
  const [pendingStuck, setPendingStuck] = useState(0)
  /** Where the pinned block ends, so the fade below it can be painted in the
   *  backdrop's colour at exactly that point rather than a guess. */
  const [pinnedHeight, setPinnedHeight] = useState(0)
  /** Where the top bar ends, so the switcher dropdown (design 4a) can anchor
   *  itself right under it instead of guessing a fixed offset. */
  const [headerHeight, setHeaderHeight] = useState(0)
  const [pendingCorrupt, setPendingCorrupt] = useState(false)
  // Per-row in-flight action, keyed by txid (or reference for abort) so only
  // the tapped row shows a spinner rather than the whole list.
  const [busyRow, setBusyRow] = useState<string | null>(null)
  /** The one row whose utility chips are open. One at a time: two open rows and
   * the chips stop obviously belonging to a transaction. */
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [pendingResends, setPendingResends] = useState<PendingResend[]>([])
  const [resending, setResending] = useState(false)
  const offsetRef = useRef(0)
  /** Set once the server has no more rows, so onEndReached stops re-querying at
   * the bottom of the list. Cleared whenever the list is refetched from 0. */
  const exhaustedRef = useRef(false)
  /** The same fact as state, for render: a filtered list that is empty has
   * only found nothing once there is no older history left to search. */
  const [historyExhausted, setHistoryExhausted] = useState(false)
  const markExhausted = useCallback((exhausted: boolean) => {
    exhaustedRef.current = exhausted
    setHistoryExhausted(exhausted)
  }, [])
  /** An older page failed to load. Stops the automatic paging below from
   * retrying in a loop; the next refetch from 0 clears it. */
  const [olderPageFailed, setOlderPageFailed] = useState(false)
  /** Synchronous in-flight latch for loadMore (state updates are async). */
  const inFlightRef = useRef(false)

  /**
   * Whether a wallet is already stored on this device, checked prompt-free
   * after migration and the initial build settle. That build gap is briefly indistinguishable
   * from "no wallet at all" — both show no permissions manager — and two
   * things key off telling them apart: ImportFromBackupPrompt below (must
   * not flash "import" over an existing user's already-populated screen)
   * and refreshBalance (must not blank a freshly-painted cached figure while
   * an existing wallet is still mid-build). Defaults to false (assume a
   * wallet exists) until the check resolves, so it can only suppress an
   * incorrect flash, never cause one.
   */
  const [knownNoStoredIdentity, setKnownNoStoredIdentity] = useState(false)
  useEffect(() => {
    setKnownNoStoredIdentity(false)
    if (!secretsReady || walletBuilding) return
    let cancelled = false
    ;(async () => {
      try {
        const exists = await hasStoredIdentity()
        if (!cancelled) setKnownNoStoredIdentity(!exists)
      } catch {
        // Unknown: err toward not showing the import prompt.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hasStoredIdentity, secretsReady, walletBuilding])

  // ── balance ─────────────────────────────────────────────────────────
  /**
   * One balance read at a time, shared by every caller.
   *
   * Mount, invalidation and pull-to-refresh all funnel through this latch, so a
   * caller arriving mid-read awaits that read instead of starting another.
   */
  const inFlightBalanceRef = useRef<Promise<void> | null>(null)
  const refreshBalance = useCallback(async () => {
    if (inFlightBalanceRef.current) return await inFlightBalanceRef.current
    const read = (async () => {
      try {
        // Demo mode owns the figure outright — no storage, no wallet, and so
        // no dependency on either having been built. Read through `demoOn`
        // rather than calling the gate again, so the dependency below is the
        // real one: it is what re-runs this read when the switch flips.
        if (demoOn && demoMod) {
          setBalance(demoMod.demoWalletBalance())
          return
        }
        // Straight to our own SQLite, deliberately NOT through the wallet's
        // listOutputs: every call through WalletStorageManager queues on one
        // FIFO reader lock, and the monitor holds that lock across network
        // broadcasts — so this read used to wait on whatever the monitor was
        // doing rather than on the database. See storage/methods/walletBalanceSql.
        // The wallet's own path stays as the fallback for the window before
        // storage and the user id are known.
        // Mid-switch the previous chain's storage is still mounted, and its
        // figure is not this network's money. Only bails when storage is
        // mounted for the WRONG chain — storageMatchesNetwork returns false
        // for a null storage too (no `.chain` to compare), which is also the
        // no-wallet-at-all case, and that one must fall through to the
        // zero-settle below rather than being swallowed here.
        if (storage && !onThisNetwork) return
        let total: number | null = null
        if (storage && walletUserId != null) {
          total = await readWalletBalance(storage, walletUserId)
        }
        if (total == null) {
          const pm = managers.permissionsManager
          if (!pm) {
            // Genuinely no wallet on this device (freshly logged out /
            // deleted) rather than an existing wallet still mid-build: settle
            // on zero so the spinner does not spin forever. Gated on the
            // confirmed, prompt-free identity check rather than merely "no
            // permissions manager yet" — that condition is also true for a
            // split second at every cold start, and would otherwise blank
            // the cached figure this same mount just painted.
            if (knownNoStoredIdentity) setBalance(0)
            return
          }
          const { totalOutputs } = await pm.listOutputs({ basket: sdk.specOpWalletBalance }, adminOriginator)
          total = totalOutputs ?? 0
        }
        setBalance(total)
        await AsyncStorage.setItem(balanceCacheKey, String(total))
      } catch {
        // Keep the last known balance on screen rather than blanking it: a
        // failed read is not "zero satoshis".
      }
    })()
    inFlightBalanceRef.current = read
    // Cleared here rather than in a `finally` inside the body: a synchronous
    // throw from the read would run that finally BEFORE the assignment above,
    // leaving a settled promise latched forever.
    void read.finally(() => {
      if (inFlightBalanceRef.current === read) inFlightBalanceRef.current = null
    })
    return await read
  }, [
    storage,
    walletUserId,
    managers.permissionsManager,
    adminOriginator,
    balanceCacheKey,
    onThisNetwork,
    knownNoStoredIdentity,
    demoOn
  ])

  /**
   * The effects below key off DATA changes, never off `refreshBalance`'s
   * identity.
   *
   * `refreshBalance` is rebuilt whenever the wallet context rebuilds, because
   * `managers.permissionsManager` is one of its deps. With that callback in an
   * effect's dependency list, a mid-session rebuild made every live instance of
   * this screen fire a fresh multi-second balance read — the "mount" effect was
   * never mount-only. What the effects actually need is *whether* a wallet
   * exists, so they depend on that instead.
   */
  const refreshBalanceRef = useRef(refreshBalance)
  useEffect(() => {
    refreshBalanceRef.current = refreshBalance
  }, [refreshBalance])
  /** Set once `mandala` exists, below; a no-op until then. */
  const mandalaRefreshRef = useRef<() => void>(() => {})
  // Either route to a figure counts: the direct read needs storage and the user
  // id, the fallback needs the permissions manager.
  const hasWallet = (storage != null && walletUserId != null) || managers.permissionsManager != null

  // The old chain's figures must not outlive the switch that ended them. The
  // cached read below refills the balance from THIS network's key a moment
  // later; the list refills once its own storage is mounted.
  useEffect(() => {
    setBalance(null)
    setActions([])
    setOfflineByTxid(new Map())
    offsetRef.current = 0
    markExhausted(false)
    setOlderPageFailed(false)
  }, [selectedNetwork, markExhausted])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Show the cached figure immediately so the screen never opens empty.
      const cached = await AsyncStorage.getItem(balanceCacheKey)
      if (cancelled) return
      if (cached != null) setBalance(Number(cached))
      await refreshBalanceRef.current()
    })()
    return () => {
      cancelled = true
    }
    // `hasWallet` covers the cold start where this screen mounts before the
    // wallet finishes building; `balanceCacheKey` covers a network switch.
    // `knownNoStoredIdentity` re-fires this once the prompt-free identity
    // check resolves — it starts false, so a genuinely wallet-less mount's
    // first pass through refreshBalance skips the zero-settle (see there) and
    // would otherwise leave the spinner with no wallet build left to finish
    // and no further balance read ever queued.
  }, [balanceCacheKey, hasWallet, knownNoStoredIdentity])

  /**
   * Returning to this screen refetches the balance and the activity list once.
   *
   * This screen stays mounted while /pay and /vault sit on top of it in the
   * stack, so neither the mount effect above nor the activity effect below runs
   * again on the way back. `txStatusVersion` covers writes that go through the
   * wallet, but relying on it alone leaves the user's own money looking stale
   * for any path that does not — an offline row queued while the network was
   * down, say — and "did that payment go through?" is the exact question this
   * screen exists to answer.
   *
   * A counter rather than a direct call: both effects below already know how to
   * fetch, so this reuses them instead of duplicating the fetch logic. Fires
   * once per return, not on a timer. The first focus is skipped — that is the
   * mount, which the effects already cover.
   */
  const [focusVersion, setFocusVersion] = useState(0)
  const firstFocusRef = useRef(true)

  const pollResendRequests = useCallback(async () => {
    const pm = managers.permissionsManager
    if (!pm || !storage) return
    try {
      const url = await readMessageBoxUrl()
      if (!url) return
      const client = new PeerPayClient({
        messageBoxHost: url,
        walletClient: pm as never,
        originator: adminOriginator
      })
      const r = await listPendingResendRequests({ client, storage })
      setPendingResends(r.pending)
    } catch {
      // Silent: an unreachable box must not alert on focus. The stored
      // unanswered count (if any) keeps the inline row visible.
    }
  }, [managers.permissionsManager, storage, adminOriginator])

  useEffect(() => {
    if (!storage) return
    let cancelled = false
    ;(async () => {
      const stored = await loadUnansweredResends(storage)
      if (cancelled) return
      setPendingResends(stored)
      await pollResendRequests()
    })()
    return () => {
      cancelled = true
    }
  }, [storage, pollResendRequests])

  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false
        return
      }
      setFocusVersion(v => v + 1)
      void pollResendRequests()
    }, [pollResendRequests])
  )

  // Re-read the figure whenever the transaction tables move — a payment sent, a
  // deposit internalized, a status change from the monitor. Skips the first pass,
  // which the mount effect above already covers.
  const balanceMountedRef = useRef(false)
  useEffect(() => {
    if (!balanceMountedRef.current) {
      balanceMountedRef.current = true
      return
    }
    void refreshBalanceRef.current()
  }, [txStatusVersion, focusVersion])

  // ── activity ────────────────────────────────────────────────────────
  const fetchActions = useCallback(
    async (offset: number) => {
      if (demoOn && demoMod) {
        setLoadError(false)
        return demoMod.demoListActions({ limit: PAGE_SIZE, offset })
      }
      if (!managers.permissionsManager) return null
      try {
        const result = await managers.permissionsManager.listActions(
          { labels: [], includeLabels: true, limit: PAGE_SIZE, offset },
          adminOriginator
        )
        if (offset === 0) setLoadError(false)
        return result
      } catch (e) {
        if (offset === 0) setLoadError(true)
        throw e
      }
    },
    [managers.permissionsManager, adminOriginator, demoOn]
  )

  const fetchOfflineRows = useCallback(async () => {
    try {
      if (storage) {
        try {
          const pending = await readUnprocessedPending(storage)
          setPendingCount(pending.count)
          setPendingStuck(pending.stuck)
          setPendingCorrupt(pending.corrupt)
        } catch {
          setPendingCount(0)
          setPendingStuck(0)
          setPendingCorrupt(getPendingCorruptNotice())
        }
      }
      const db = storage?.sqliteDb
      if (!db) return
      const rows = await findOfflineActions(db, {
        status: ['queued', 'posting', 'rejected', 'parked'],
        ...(walletUserId === null ? {} : { userId: walletUserId })
      })
      setOfflineByTxid(new Map(rows.map(r => [r.txid, r])))
      setStalled(TaskSendOffline.lastStall)
    } catch {
      // Advisory overlay only — a read failure must not break the list.
    }
  }, [storage, walletUserId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Same gate as the balance: until the mounted storage belongs to the
      // network on screen, the wallet answering listActions is still the
      // previous chain's, and its payments are not this network's. A null
      // storage (no wallet created yet) also fails this gate, and has
      // nothing to load — settle the spinner instead of leaving it spinning
      // until a wallet exists.
      // Demo mode has no storage and no wallet by design, so it can never
      // satisfy the network gate below — and must not be asked to.
      if (!demoOn && !onThisNetwork) {
        if (!storage) setLoading(false)
        return
      }
      if (actions.length === 0) setLoading(true)
      try {
        const result = await fetchActions(0)
        if (cancelled) return
        if (!result) {
          // No permissionsManager yet (no wallet created — see the lazy
          // creation flow above): there is nothing to load, so settle the
          // spinner instead of leaving it spinning forever.
          setLoading(false)
          return
        }
        setActions(result.actions as ActivityAction[])
        offsetRef.current = result.actions.length
        // A fresh first page may have more behind it again.
        markExhausted(result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0))
        setOlderPageFailed(false)
        setLoading(false)
      } catch {
        if (cancelled) return
        setLoadError(true)
        setLoading(false)
      }
    })()
    void fetchOfflineRows()
    setAttentionCount(TaskCreditInbox.lastAttentionCount)
    if (storage) {
      void getOutboxEntries(storage).then(entries => {
        if (!cancelled) setUnsentCount(unsentEntries(entries).length)
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchActions, txStatusVersion, focusVersion, fetchOfflineRows, storage, onThisNetwork, demoOn])

  const loadMore = useCallback(async () => {
    // Three guards, all load-bearing:
    //  - exhaustedRef: without it, reaching the bottom fires onEndReached
    //    forever — each pass runs a real listActions query, returns nothing, and
    //    the footer swapping between spinner and spacer changes content height,
    //    which makes FlatList re-evaluate and fire again. That is a tight loop.
    //  - inFlightRef: `loadingMore` is state, so two onEndReached calls in the
    //    same tick would both read the stale `false` and double-fetch.
    //  - loading: the first page is still landing; its result sets the offset.
    if (exhaustedRef.current || inFlightRef.current || loading) return
    inFlightRef.current = true
    setLoadingMore(true)
    try {
      const result = await fetchActions(offsetRef.current)
      const page = (result?.actions ?? []) as ActivityAction[]
      if (page.length) {
        setActions(prev => [...prev, ...page])
        offsetRef.current += page.length
      }
      // A short page means the end; so does reaching the reported total.
      if (page.length < PAGE_SIZE || offsetRef.current >= (result?.totalActions ?? 0)) {
        markExhausted(true)
      }
    } catch {
      // Keep existing rows; a failed page is not the end of the list.
      setOlderPageFailed(true)
    } finally {
      inFlightRef.current = false
      setLoadingMore(false)
    }
  }, [fetchActions, loading, markExhausted])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // Rides along because the balance tap no longer refreshes anything —
      // without it, a held token would have no refresh path left. Through a
      // ref because `mandala` is built further down this component than this
      // callback is.
      mandalaRefreshRef.current()
      const [result, , , entries] = await Promise.all([
        fetchActions(0),
        refreshBalance(),
        fetchOfflineRows(),
        storage ? getOutboxEntries(storage) : Promise.resolve([])
      ])
      if (result) {
        setActions(result.actions as ActivityAction[])
        offsetRef.current = result.actions.length
        markExhausted(result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0))
        setOlderPageFailed(false)
      }
      setAttentionCount(TaskCreditInbox.lastAttentionCount)
      setUnsentCount(unsentEntries(entries).length)
    } catch {
      // loadError is set by fetchActions for a first-page failure.
    } finally {
      setRefreshing(false)
    }
  }, [fetchActions, refreshBalance, fetchOfflineRows, storage, markExhausted])

  const onExport = useCallback(async () => {
    if (exporting || actions.length === 0 || !managers.permissionsManager) return
    setExporting(true)
    try {
      const count = await exportTransactionsAsCsv(managers.permissionsManager, storage, adminOriginator)
      if (count === 0) showToast(t('no_transactions'), { type: 'info' })
    } catch {
      showToast(t('tx_export_failed'), { type: 'error' })
    } finally {
      setExporting(false)
    }
  }, [exporting, actions.length, managers.permissionsManager, storage, adminOriginator, t])

  // ── per-row actions ──────────────────────────────────────────────────

  /** Open the transaction on a block explorer in the system browser. */
  const onExplorer = useCallback(
    (txid: string) => {
      const base =
        selectedNetwork === 'main'
          ? 'https://whatsonchain.com'
          : selectedNetwork === 'teratest'
            ? 'https://woc-ttn.bsvblockchain.tech'
            : 'https://test.whatsonchain.com'
      Linking.openURL(`${base}/tx/${txid}`).catch(() => {
        showToast(t('explorer_open_failed'), { type: 'error' })
      })
    },
    [selectedNetwork, t]
  )

  /** Copy the transaction's full BEEF (raw tx + the proofs/ancestry that make
   * it independently verifiable) as hex — what you paste into a tool or hand to
   * support, unlike a bare txid. */
  const onRefreshTx = useCallback(
    async (txid: string) => {
      if (busyRow) return
      setBusyRow(txid)
      try {
        const outcome = await refreshProof(txid)
        if (outcome === 'confirmed') showToast(t('tx_proof_refreshed'), { type: 'success' })
        else if (outcome === 'failed') showToast(t('tx_marked_failed'), { type: 'info' })
        else showToast(t('tx_still_pending'), { type: 'info' })
      } catch {
        showToast(t('tx_proof_refresh_failed'), { type: 'error' })
      } finally {
        setBusyRow(null)
        setBusyLabel(undefined)
      }
    },
    [busyRow, refreshProof, t]
  )

  /** Abort a still-local transaction, releasing the inputs it reserved. */
  const onAbort = useCallback(
    async (reference: string) => {
      if (!managers.permissionsManager || busyRow) return
      setBusyRow(reference)
      try {
        const r = (await managers.permissionsManager.abortAction({ reference }, adminOriginator)) as
          | { aborted?: boolean }
          | undefined
        if (!r || r.aborted === false) {
          showToast(t('tx_abort_failed'), { type: 'error' })
        } else {
          showToast(t('tx_abort_success'), { type: 'success' })
          await onRefresh()
        }
      } catch {
        showToast(t('tx_abort_failed'), { type: 'error' })
      } finally {
        setBusyRow(null)
        setBusyLabel(undefined)
      }
    },
    [managers.permissionsManager, adminOriginator, busyRow, onRefresh, t]
  )

  const onResendPending = useCallback(async () => {
    if (resending) return
    setResending(true)
    try {
      const pm = managers.permissionsManager
      if (!pm || !storage) throw new Error(t('unknown_error'))
      const url = await readMessageBoxUrl()
      if (!url) {
        showToast(t('message_box_unreachable'), { type: 'error' })
        return
      }
      const client = new PeerPayClient({
        messageBoxHost: url,
        walletClient: pm as never,
        originator: adminOriginator
      })
      const r = await handleResendRequests({
        client,
        storage,
        listPeerPayAction: makeListPeerPayAction(pm, adminOriginator),
        decryptMetadata: makeMetadataDecryptor(pm, adminOriginator),
        refetch: makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline })
      })
      setPendingResends(r.pending)
      if (r.pending.length === 0) haptics.success()
      else showToast(t('unknown_error'), { type: 'error' })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : t('unknown_error')
      showToast(message, { type: 'error' })
    } finally {
      setResending(false)
    }
  }, [resending, managers.permissionsManager, storage, adminOriginator, selectedNetwork, t])

  const onSendPaymentDetails = useCallback(
    async (txid: string) => {
      if (busyRow) return
      setBusyRow(txid)
      setBusyLabel(t('resend_sending'))
      try {
        const pm = managers.permissionsManager
        if (!pm || !storage) throw new Error(t('unknown_error'))
        // Network first for a fresh proof; this device's own copy when the
        // network has never heard of the transaction — a nearby payment whose
        // code was never scanned is `nosend`, and that is the case a resend
        // most needs to cover.
        const refetch = makeResendBeef({
          refetch: makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline }),
          storage
        })
        const decryptMetadata = makeMetadataDecryptor(pm, adminOriginator)
        // Every resend goes over the message box, whatever rail the payment
        // first took. What differs is the body: a token row re-sends the
        // Mandala transfer notification (the runtime rebuilds it from the
        // blinding journal and the payee output's marker); a BSV row rebuilds
        // its BRC-29 PeerPay token. Identification is by LABEL, like every
        // other token decision on this screen.
        const isToken = actions.find(a => a.txid === txid)?.labels?.includes('mandala') ?? false
        let outcome: Awaited<ReturnType<typeof resendPaymentDetails>>
        if (isToken) {
          if (!mandalaRuntime) throw new Error(t('unknown_error'))
          outcome = await mandalaRuntime.resendTransfer(txid, { refetch, decryptMetadata })
        } else {
          const url = await readMessageBoxUrl()
          if (!url) {
            showToast(t('message_box_unreachable'), { type: 'error' })
            return
          }
          const client = new PeerPayClient({
            messageBoxHost: url,
            walletClient: pm as never,
            originator: adminOriginator
          })
          outcome = await resendPaymentDetails({
            client,
            storage,
            txid,
            listPeerPayAction: makeListPeerPayAction(pm, adminOriginator),
            decryptMetadata,
            refetch
          })
        }
        if (outcome.ok) {
          // A parked payment has now been handed over for real, over a rail
          // that confirms delivery. Release it so this wallet broadcasts it
          // too, instead of leaving it looking like it never went anywhere.
          if (storage && offlineByTxid.get(txid)?.status === 'parked') {
            try {
              await releaseParkedPayment({ storage, txid })
            } catch (e) {
              console.warn('[localpay] resent but could not release:', e instanceof Error ? e.message : e)
            }
            await onRefresh()
          }
          haptics.success()
          showToast(t('resend_sent'), { type: 'success' })
        } else {
          // Each reason is a different thing for the user to do — or not do.
          // Collapsing them into "Unknown error" told someone whose payment can
          // never be rebuilt to keep tapping a button that cannot work.
          showToast(t(`resend_failed_${outcome.reason}`), { type: 'error' })
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : t('unknown_error')
        showToast(message, { type: 'error' })
      } finally {
        setBusyRow(null)
        setBusyLabel(undefined)
      }
    },
    [
      busyRow,
      managers.permissionsManager,
      storage,
      adminOriginator,
      selectedNetwork,
      offlineByTxid,
      onRefresh,
      t,
      actions,
      mandalaRuntime
    ]
  )

  const onFailedSendAgain = useCallback(
    async (action: ActivityAction) => {
      if (busyRow) return
      if (action.txid && storage && managers.permissionsManager) {
        const entry = unsentEntries(await getOutboxEntries(storage)).find(e => e.txid === action.txid)
        if (entry) {
          setBusyRow(action.txid)
          try {
            // Host order on any re-delivery: the recipient's advertised inbox
            // (the client re-resolves it per send, so a host anointed since the
            // original attempt is picked up), then whatever this wallet is
            // configured for NOW — the setting may have changed since the
            // payment was minted — and only then the host recorded at send
            // time, which is the last thing still worth trying if the user has
            // since opted out of a server.
            const client = makePeerPayClient({
              wallet: managers.permissionsManager as never,
              messageBoxUrl: (await readMessageBoxUrl()) ?? entry.messageBoxUrl,
              originator: adminOriginator
            })
            if (!client) {
              showToast(t('message_box_unreachable'), { type: 'error' })
              return
            }
            await retryDelivery({
              wallet: managers.permissionsManager as never,
              adminOriginator,
              client,
              storage,
              entry
            })
            haptics.success()
            await onRefresh()
          } catch (e: unknown) {
            const message = isMessageBoxNetworkError(e)
              ? t('message_box_unreachable')
              : e instanceof Error
                ? e.message
                : t('unknown_error')
            showToast(message, { type: 'error' })
          } finally {
            setBusyRow(null)
          }
          return
        }
      }
      const sats = Math.abs(action.satoshis)
      router.push(sats > 0 ? `/pay?sats=${sats}` : '/pay')
    },
    [busyRow, storage, managers.permissionsManager, adminOriginator, onRefresh, t]
  )

  const toggleRow = useCallback((key: string) => {
    setExpandedRow(prev => (prev === key ? null : key))
  }, [])

  const offlineRows = useMemo(() => [...offlineByTxid.values()], [offlineByTxid])
  const rejected = useMemo(
    () => offlineRows.filter(r => r.status === 'rejected' && r.role === 'received'),
    [offlineRows]
  )
  const sentRejected = useMemo(
    () => offlineRows.filter(r => r.status === 'rejected' && r.role === 'sent'),
    [offlineRows]
  )
  // Parked payments are counted apart from queued ones: nothing is waiting to
  // broadcast them, so folding them into "waiting to be broadcast" would say
  // something untrue about both.
  //
  // The rest pass through the grace filter: online, a payment the drain is
  // about to post says nothing worth reading, and the banner appearing for the
  // half second before it lands reads as a fault that is not there.
  const queued = useMemo(() => offlineRows.filter(r => r.status !== 'rejected' && r.status !== 'parked'), [offlineRows])
  const { shown: queuedShown, nextCheckMs } = useMemo(
    // graceNonce is a dependency only: it carries no value into the call, it
    // just re-runs it once a young row has aged past the grace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => partitionQueueByGrace(queued, { online, nowMs: Date.now() }),
    [queued, online, graceNonce]
  )
  // A row that is merely young becomes newsworthy by the passage of time alone,
  // and nothing else would wake this screen to notice.
  useEffect(() => {
    if (nextCheckMs === undefined) return
    const t = setTimeout(() => setGraceNonce(n => n + 1), nextCheckMs + 100)
    return () => clearTimeout(t)
  }, [nextCheckMs])
  const queuedCount = queuedShown.length
  const queuedSent = useMemo(() => queuedShown.filter(r => r.role === 'sent'), [queuedShown])
  // ── stablecoins ─────────────────────────────────────────────────────
  // Every token surface below is conditional on a fact being true, and the
  // first fact is "you hold one": with no runtime and no balances this screen
  // renders exactly what it rendered before any of this existed.
  const mandala = useMandala()
  // Assigned in an effect, not during render: a render-phase ref mutation is
  // impure and React is entitled to discard or replay the render around it.
  useEffect(() => {
    mandalaRefreshRef.current = mandala.refresh
  }, [mandala.refresh])
  const tokenActivity = useTokenActivity()
  const tokenByTxid = useMemo(() => tokenActivityByTxid(tokenActivity.rows), [tokenActivity.rows])
  const seenEvictions = useSeenSet(SEEN_EVICTIONS_KEY)
  /** True the moment any token balance exists — the gate for the coin switcher. */
  const hasTokens = (mandala.balances?.length ?? 0) > 0

  // ── the coin on screen ──────────────────────────────────────────────
  /**
   * Which money the screen is showing (design 1b, 2026-09-15): `null` is BSV,
   * the default and the only coin a wallet with no token ever shows. Picked in
   * the switcher the hero label opens; it decides the hero figure, which
   * activity rows are listed, and what Pay / Get paid are armed with — so the
   * Pay screen never asks the asset question a second time.
   */
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const heldAsset = useMemo(
    () => (selectedAssetId ? (mandala.balances?.find(b => b.asset.assetId === selectedAssetId) ?? null) : null),
    [selectedAssetId, mandala.balances]
  )
  // A coin that is no longer held (spent to zero, or a wallet switch) falls
  // back to BSV. `balances === null` is UNKNOWN, not "holds nothing", and
  // decides nothing.
  useEffect(() => {
    if (selectedAssetId && mandala.balances && !heldAsset) setSelectedAssetId(null)
  }, [selectedAssetId, mandala.balances, heldAsset])

  /**
   * Money that left without a sentence. `showAlert`, once per transaction —
   * the one modal this feature spends, because a balance that simply drops is
   * the worst failure in the system on a phone.
   */
  useEffect(() => {
    const pending = evictionsFrom(tokenActivity.rows, seenEvictions.seen)
    if (pending.length === 0) return
    let live = true
    void (async () => {
      for (const notice of pending) {
        if (!live) return
        // Marked before the await resolves: an alert the user dismisses by
        // backgrounding the app must not re-fire on every foreground after.
        seenEvictions.see(notice.txid)
        await announceEviction(t, notice)
      }
    })()
    return () => {
      live = false
    }
    // `seenEvictions.see` is stable; `seen` is the gate and belongs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenActivity.rows, seenEvictions.seen, t])

  const stuckBadges = useMemo(
    () =>
      homeBadges({
        attention: attentionCount,
        unsent: unsentCount,
        offlineQueued: queuedCount,
        offlineRejected: rejected.length + sentRejected.length,
        tokenAttention: mandala.stuck.length
      }).filter(b => b.kind !== 'offline'),
    [attentionCount, unsentCount, queuedCount, rejected.length, sentRejected.length, mandala.stuck.length]
  )
  const reloadOffline = useCallback(() => {
    void fetchOfflineRows()
  }, [fetchOfflineRows])
  const pushPay = useCallback((sats?: number) => {
    router.push(sats && sats > 0 ? `/pay?sats=${sats}` : '/pay')
  }, [])
  /** `/pay` for the coin on screen: a token rides along as `?asset=`, BSV needs nothing. */
  const payDestination = useCallback(
    (direction: 'pay' | 'get') => {
      const base = direction === 'get' ? '/pay?direction=get' : '/pay'
      if (!heldAsset) return base
      return `${base}${direction === 'get' ? '&' : '?'}asset=${encodeURIComponent(heldAsset.asset.assetId)}`
    },
    [heldAsset]
  )
  const { onRequestAgain, onCopyDetails, onDismiss, onSendAgain } = useOfflineNoticeActions({
    storage,
    permissionsManager: managers.permissionsManager,
    adminOriginator,
    online,
    rejected,
    t,
    reload: reloadOffline,
    pushPay
  })

  // ── rows ────────────────────────────────────────────────────────────
  /**
   * The activity list follows the coin on screen. A token shows only its own
   * transfers; BSV, once a token is held, hides them — a "Sent USDX" row under
   * a BSV figure would read as BSV leaving. A wallet with no token filters
   * nothing, and lists exactly what it listed before any of this existed.
   * Token rows are recognised by LABEL, not by holdings, like `renderItem`.
   */
  const visibleActions = useMemo(() => {
    if (!hasTokens) return actions
    if (heldAsset) {
      return actions.filter(
        a => !!a.txid && tokenByTxid.get(a.txid.toLowerCase())?.asset.assetId === heldAsset.asset.assetId
      )
    }
    return actions.filter(a => !a.labels?.includes('mandala'))
  }, [actions, hasTokens, heldAsset, tokenByTxid])

  /** Cancel a parked payment: abort the action so the inputs come back, and
   * retire its queue row. Refuses once the counterparty has broadcast. */
  const onCancelParked = useCallback(
    async (txid: string) => {
      const pm = managers.permissionsManager
      if (!storage || !pm || busyRow) return
      setBusyRow(txid)
      setBusyLabel(t('cancelling_payment'))
      // FIX J: a token payment's cancel is overlay-authoritative — pass the
      // settlement deps so `cancelParkedPayment` checks admission before
      // aborting, refusing with 'already-sent' if the recipient's own submit
      // already beat the cancel (rule 3: the RECIPIENT settles the hop).
      // `mandalaSettlement` is `undefined` whenever Mandala is unavailable,
      // which leaves a plain BSV cancel exactly as it behaves today.
      const isTokenRow = tokenByTxid.has(txid)
      try {
        const outcome = await cancelParkedPayment({
          storage,
          wallet: pm as unknown as CancelParkedWallet,
          originator: adminOriginator,
          txid,
          settlement: mandalaSettlement
        })
        if (outcome === 'cancelled') showToast(t('tx_abort_success'), { type: 'success' })
        else if (outcome === 'already-sent') {
          showToast(t(isTokenRow ? 'token_cancel_already_sent' : 'pay_parked_already_sent'), { type: 'info' })
        } else showToast(t('tx_abort_failed'), { type: 'error' })
        await onRefresh()
      } catch (e: unknown) {
        showToast(e instanceof Error ? e.message : t('unknown_error'), { type: 'error' })
      } finally {
        setBusyRow(null)
        setBusyLabel(undefined)
      }
    },
    [storage, managers.permissionsManager, adminOriginator, busyRow, onRefresh, t, mandalaSettlement, tokenByTxid]
  )

  /**
   * The token half of each row, precomputed and keyed by txid.
   *
   * Built once per activity change rather than inline per render: `ActivityRow`
   * is memoised on prop identity, and a fresh object per render would defeat that
   * for exactly the rows a token holder scrolls past most.
   */
  const tokenProps = useMemo(() => {
    const actionByTxid = new Map(actions.filter(a => a.txid).map(a => [a.txid as string, a]))
    const map = new Map<string, NonNullable<React.ComponentProps<typeof ActivityRow>['token']>>()
    for (const [txid, row] of tokenByTxid) {
      const signedBaseUnits = row.role === 'sent' ? -row.baseUnits : row.baseUnits
      const figure = formatTokenAmount(signedBaseUnits, row.asset.decimals, {
        showPlus: row.role === 'received'
      })
      const action = actionByTxid.get(txid)
      map.set(txid, {
        title: tokenRowTitle({
          role: row.role,
          ticker: row.asset.ticker,
          labels: action?.labels,
          description: action?.description,
          assetId: row.asset.assetId,
          baseUnits: row.baseUnits,
          t
        }),
        amount: figure ? { value: figure, unit: row.asset.ticker } : undefined,
        incoming: row.role === 'received',
        // The same generative face a BSV row draws, keyed on the token row's
        // OWN counterparty key rather than the wallet action's labels/sender
        // (meaningless for a token transfer) — see TokenActivityRow.counterpartyKey.
        // A received row is keyed on the sender's blinded per-payment key A′
        // by design (spec D2): the image differs on every payment from the
        // same payer, which is the point of the blinding, not a bug in it.
        counterpartyKey: row.counterpartyKey,
        status: tokenRowStatusView(row.status, row.role === 'received'),
        statusText: t(tokenRowStatusView(row.status, row.role === 'received').key)
      })
    }
    return map
  }, [tokenByTxid, actions, t])

  /** The coin's rows, narrowed further while the activity filter is in use. */
  const filteredActions = useMemo(() => {
    if (!filterActive) return visibleActions
    return visibleActions.filter(action => {
      // Same token lookup as `renderItem`: the filter reads the row it draws.
      const key = action.txid || action.reference || ''
      const token = action.labels?.includes('mandala') ? tokenProps.get(key) : undefined
      return matchesActivity(action, token, activityFilter, contactNames)
    })
  }, [visibleActions, filterActive, activityFilter, contactNames, tokenProps])
  const rows = useMemo(() => withDayHeaders(filteredActions, t), [filteredActions, t])

  // A filtered page can come up short — or empty — while the server still has
  // more, and a list too short to scroll never fires onEndReached. Keep
  // paging until the visible list is a page long or the history is spent.
  // A search pages the same way, so a note from months back is still found.
  useEffect(() => {
    if ((!hasTokens && !filterActive) || loading || loadingMore || actions.length === 0) return
    if (filteredActions.length >= PAGE_SIZE || historyExhausted || olderPageFailed) return
    void loadMore()
  }, [
    hasTokens,
    filterActive,
    loading,
    loadingMore,
    actions.length,
    filteredActions.length,
    historyExhausted,
    olderPageFailed,
    loadMore
  ])

  /** The row's own display fields, in the shape the detail view draws from. */
  // Plain functions, not `useCallback`: each runs at most once per render (only
  // when a row is open) and memoizing them buys nothing, while calling a
  // memoized callback during render trips the compiler's purity rule.
  const detailParams = (action: ActivityAction): TransactionDetailParams => {
      const key = action.txid || action.reference || ''
      const token = action.labels?.includes('mandala') ? tokenProps.get(key) : undefined
      return {
        txid: action.txid,
        satoshis: action.satoshis,
        status: action.status,
        description: action.description,
        isOutgoing: action.isOutgoing,
        createdAt: action.created_at ? new Date(action.created_at).toISOString() : undefined,
        counterpartyKey: token?.counterpartyKey ?? action.senderIdentityKey,
        ...(token
          ? {
              token: {
                title: token.title,
                amount: token.amount,
                incoming: token.incoming,
                statusText: token.statusText
              }
            }
          : {})
      }
  }

  /**
   * The utilities that used to unfold inside an expanded row, as the detail
   * view's overflow menu. Same handlers, same guards — only the surface moved.
   */
  const detailActions = (action: ActivityAction): TransactionAction[] => {
      const out: TransactionAction[] = []
      const offline = action.txid ? offlineByTxid.get(action.txid) : undefined
      const parked = offline?.status === 'parked'
      if (action.txid && !parked && offline?.status !== 'queued' && offline?.status !== 'posting') {
        out.push({
          key: 'refresh',
          label: t('tx_action_refresh'),
          icon: 'refresh-outline',
          onPress: () => void onRefreshTx(action.txid)
        })
      }
      if (action.txid && !parked) {
        out.push({
          key: 'explorer',
          label: t('tx_action_explorer'),
          icon: 'link-outline',
          onPress: () => onExplorer(action.txid)
        })
      }
      if (action.reference && ABORTABLE_DETAIL_STATUSES.has(action.status)) {
        out.push({
          key: 'abort',
          label: t('tx_action_abort'),
          icon: 'close-circle-outline',
          danger: true,
          onPress: () => void onAbort(action.reference!)
        })
      }
      if (parked && action.txid) {
        out.push({
          key: 'cancel-parked',
          label: t('pay_parked_cancel'),
          icon: 'close-circle-outline',
          danger: true,
          onPress: () => void onCancelParked(action.txid)
        })
      }
    return out
  }



  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item, index }) => {
      if (item.kind === 'day') {
        return <Text style={[styles.dayHeader, { color: colors.textTertiary }]}>{item.label}</Text>
      }
      const key = item.txid || item.reference || `row-${index}`
      const offline = item.txid ? offlineByTxid.get(item.txid) : undefined
      const busy = busyRow === item.txid || (!!item.reference && busyRow === item.reference)
      // Identification is by LABEL, not by holdings: a user who sends their
      // last token keeps denomination across their whole history.
      const token = item.labels?.includes('mandala') ? tokenProps.get(key) : undefined

      return (
        <ActivityRow
          currency={currency}
          walletUserId={walletUserId}
          contactsStore={contactsStore}
          action={item}
          rowKey={key}
          token={token}
          offlineStatus={offline?.status}
          expanded={expandedRow === key}
          busy={busy}
          busyLabel={busyLabel}
          onToggle={toggleRow}
          onOpen={setOpenTx}
          onExplorer={onExplorer}
          onRefreshTx={onRefreshTx}
          onAbort={onAbort}
          onSendPaymentDetails={onSendPaymentDetails}
          onSendAgain={onFailedSendAgain}
          onCancelParked={onCancelParked}
        />
      )
    },
    [
      colors,
      currency,
      walletUserId,
      contactsStore,
      offlineByTxid,
      tokenProps,
      busyRow,
      busyLabel,
      expandedRow,
      toggleRow,
      onExplorer,
      onRefreshTx,
      onAbort,
      onSendPaymentDetails,
      onFailedSendAgain,
      onCancelParked
    ]
  )

  // ── header (balance + the three destinations + activity heading) ─────
  const balanceParts = useMemo(
    () =>
      balance === null
        ? null
        : formatAmountParts(balance, displayCurrency, satoshisPerUSD, { abbreviate: true, usdToFiat }),
    [balance, displayCurrency, satoshisPerUSD, usdToFiat]
  )

  /**
   * Pinned above the list, not part of it.
   *
   * The balance and the two destinations are what someone opens this screen
   * for; scrolling a long history used to carry them off the top, so the
   * answer to "how much do I have" and the way to pay were both a scroll back
   * up. Everything below them still scrolls with the activity it describes.
   */
  /** The hero figure: the token on screen, or the BSV balance. `null` is UNKNOWN. */
  const heroParts = heldAsset ? tokenAmountParts(heldAsset.baseUnits, heldAsset.asset) : balanceParts
  const heroText = heroParts ? `${heroParts.value} ${heroParts.unit}`.trim() : undefined

  const pinnedHeader = useMemo(
    () => (
      <View>
        <TouchableOpacity
          /**
           * Flips the denomination. Refreshing moved to the list's own
           * pull gesture, so this tap means exactly one thing.
           *
           * A token has no price the wallet can stand behind (ux §6.1), so
           * there is nothing to flip TO while one is on screen — the tap is
           * inert rather than converting a stablecoin into an invented
           * fiat figure.
           */
          onPress={heldAsset ? undefined : () => setFlipped(f => !f)}
          disabled={Boolean(heldAsset)}
          activeOpacity={0.7}
          style={styles.balanceBlock}
          accessibilityLabel={
            heldAsset
              ? undefined
              : t('wallet_balance_show_in', {
                  unit: displayCurrency === 'BSV' ? (isFiatCurrency(currency) ? currency : 'USD') : 'BSV'
                })
          }
          accessibilityValue={heroText ? { text: heroText } : undefined}
        >
          {/* With a token held, the coin switcher pill in the top bar IS the
              label (design 4a) — this block needs none of its own. Without a
              token it is the plain "You have" of today's screen — a holder
              with 1,240.00 USDX and no BSV must not read "You have / 0 sats"
              at display size with their real money elsewhere. */}
          {!hasTokens && (
            <Text style={[styles.balanceLabel, { color: colors.textTertiary }]}>{t('wallet_balance_you_have')}</Text>
          )}
          {heroParts === null ? (
            <ActivityIndicator color={colors.textSecondary} style={styles.balanceSpinner} />
          ) : (
            <>
              {/* However long the figure, it stays on one line: the type shrinks
                  to fit (see FitAmount for why this is not adjustsFontSizeToFit). */}
              <FitAmount
                value={heroParts.value}
                unit={heroParts.unit}
                style={[styles.balance, { color: colors.textPrimary }]}
                unitStyle={[styles.balanceUnit, { color: colors.textSecondary }]}
              />
              {/* A token keeps this line for its full name, so "1,240.00 USDX"
                  is never a ticker the holder has to decode. BSV no longer
                  carries a conversion line: the same money in the other
                  denomination is one tap on the figure away, and printing
                  both at once was two figures competing to be THE balance. */}
              {heldAsset ? (
                <Text style={[styles.balanceContext, { color: colors.textSecondary }]}>
                  {heldAsset.asset.label || heldAsset.asset.issuerName || ''}
                </Text>
              ) : null}
            </>
          )}
        </TouchableOpacity>

        {/* The destinations. Pay is the only accent-filled element on this
            screen, so the eye lands on it first. */}
        <View style={styles.destinations}>
          <PressableScale
            haptic="confirm"
            onPress={() => destinationPress(payDestination('pay'))}
            style={[styles.dest, styles.destPrimary, { backgroundColor: colors.accent }]}
          >
            <MaterialCommunityIcons name="arrow-top-right" size={19} color={colors.textOnAccent} />
            <Text style={[styles.destLabel, styles.destLabelPrimary, { color: colors.textOnAccent }]}>
              {t('pay_direction_pay')}
            </Text>
          </PressableScale>

          <PressableScale
            haptic="confirm"
            onPress={() => destinationPress(payDestination('get'))}
            style={[styles.dest, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          >
            <MaterialCommunityIcons name="arrow-bottom-left" size={19} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>{t('pay_direction_receive')}</Text>
          </PressableScale>

          {/* Release- and network-gated (spec §5.5, task 11): no Vault
              destination until the host turns vaultEnabled on, and never off
              mainnet. `selectedNetwork` is a dependency of this memo, so the
              destination appears and disappears with a network switch. Plain
              push, not destinationPress — enrolment needs no wallet, and the
              Vault screen's own Deposit button runs the lazy wallet-creation
              path when it comes to that. */}
          {isVaultAvailable(selectedNetwork) && (
            <PressableScale
              haptic="confirm"
              onPress={() => router.push('/vault')}
              style={[styles.dest, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
            >
              <MaterialCommunityIcons name="safe" size={19} color={colors.textPrimary} />
              <Text style={[styles.destLabel, { color: colors.textPrimary }]}>{t('wallet_vault')}</Text>
            </PressableScale>
          )}
        </View>
      </View>
    ),
    [
      heroParts,
      heroText,
      colors,
      t,
      router,
      selectedNetwork,
      hasTokens,
      heldAsset,
      payDestination,
      destinationPress,
      MaterialCommunityIcons
    ]
  )

  /** The issuer a single stuck row is waiting on, when it can be named. */
  const stuckIssuerName = useMemo(() => {
    const first = mandala.stuck[0]
    const held = first ? (mandala.balances ?? []).find(b => b.asset.assetId === first.assetId) : undefined
    return held?.asset.issuerName || t('token_issuer_fallback')
  }, [mandala.stuck, mandala.balances, t])

  const listHeader = useMemo(
    () => (
      <View>
        {pendingResends.length > 0 || stuckBadges.length > 0 ? (
          <View style={styles.resendBanner}>
            {pendingResends.length > 0 ? (
              <GroupedSection>
                <ListRow
                  label={t('resend_requested')}
                  icon="refresh-outline"
                  iconColor={colors.warning}
                  showChevron={false}
                  isLast
                  onPress={resending ? undefined : () => void onResendPending()}
                  trailing={
                    resending ? (
                      <View style={styles.resendTrailing}>
                        <ActivityIndicator size="small" color={colors.accent} />
                        <Text style={[styles.resendAction, { color: colors.accent }]}>{t('resending')}</Text>
                      </View>
                    ) : (
                      <Text style={[styles.resendAction, { color: colors.accent }]}>{t('resend')}</Text>
                    )
                  }
                />
              </GroupedSection>
            ) : null}
            {stuckBadges.length > 0 ? (
              <GroupedSection>
                {stuckBadges.map((badge, i) => (
                  <ListRow
                    key={badge.kind}
                    label={
                      badge.kind === 'attention'
                        ? t('home_payments_need_attention', { count: badge.count })
                        : badge.kind === 'token_attention'
                          ? // One stuck payment can name the issuer it is waiting
                            // on; several cannot, so the plural says the true
                            // thing instead of naming one of them.
                            badge.count === 1
                            ? t('token_attention_one', { issuer: stuckIssuerName })
                            : t('token_attention_many', { count: badge.count })
                          : t('home_payments_unsent', { count: badge.count })
                    }
                    icon={
                      badge.kind === 'attention'
                        ? 'alert-circle-outline'
                        : badge.kind === 'token_attention'
                          ? 'time-outline'
                          : 'send-outline'
                    }
                    iconColor={colors.warning}
                    isLast={i === stuckBadges.length - 1}
                    onPress={() => {
                      if (badge.kind === 'token_attention') {
                        // No per-asset sheet in v1 (2026-09-15 maintainer
                        // decision): route to Pay with that asset selected, so
                        // the holder lands on the form that can actually move
                        // — or retry — the stuck payment.
                        const assetId = mandala.stuck[0]?.assetId
                        router.push(
                          (assetId ? `/pay?asset=${encodeURIComponent(assetId)}` : '/pay') as Parameters<
                            typeof router.push
                          >[0]
                        )
                        return
                      }
                      router.push(badge.kind === 'attention' ? '/pay?cell=get-handle' : '/pay?cell=pay-handle')
                    }}
                  />
                ))}
              </GroupedSection>
            ) : null}
          </View>
        ) : null}

        <OfflineNotice
          compact
          online={online}
          queued={queuedCount}
          rejected={rejected}
          sentRejected={sentRejected}
          onSendNow={() => TaskSendOffline.requestNow()}
          stalled={stalled}
          pendingCount={pendingCount}
          pendingStuck={pendingStuck}
          pendingCorrupt={pendingCorrupt}
          queuedSent={queuedSent}
          onShowCode={() => router.push('/pay')}
          onRequestAgain={row => void onRequestAgain(row)}
          onCopyDetails={onCopyDetails}
          onDismiss={row => void onDismiss(row)}
          onSendAgain={row => void onSendAgain(row)}
        />

        <View style={styles.activityHead}>
          <Text style={[styles.activityTitle, { color: colors.textPrimary }]}>{t('wallet_activity')}</Text>
          <View style={styles.activityTools}>
            {/* Filled while open, like a selected chip below it: the panel it
                controls is on screen, so the button says it is on. */}
            <TouchableOpacity
              onPress={toggleFilter}
              // Never disabled while open: an emptied list (a network switch)
              // must not strand the panel with no way to close it.
              disabled={actions.length === 0 && !filterOpen}
              hitSlop={8}
              style={[
                styles.filterBtn,
                filterOpen
                  ? { backgroundColor: colors.accent, borderColor: colors.accent }
                  : { borderColor: colors.surfaceRaisedBorder }
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('activity_filter')}
              accessibilityState={{ expanded: filterOpen }}
            >
              <Ionicons
                name="filter-outline"
                size={14}
                color={
                  filterOpen ? colors.textOnAccent : actions.length === 0 ? colors.textTertiary : colors.textSecondary
                }
              />
            </TouchableOpacity>
            {/* "Export", not "Export CSV", to leave the filter room beside it;
                a screen reader still hears the format. */}
            <TouchableOpacity
              onPress={onExport}
              disabled={exporting || actions.length === 0}
              hitSlop={8}
              style={[styles.exportBtn, { borderColor: colors.surfaceRaisedBorder }]}
              accessibilityRole="button"
              accessibilityLabel={t('tx_export_csv')}
            >
              {exporting ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Ionicons
                  name="download-outline"
                  size={12}
                  color={actions.length === 0 ? colors.textTertiary : colors.textSecondary}
                />
              )}
              <Text
                style={[
                  styles.exportLabel,
                  { color: actions.length === 0 ? colors.textTertiary : colors.textSecondary }
                ]}
              >
                {t('tx_export')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {filterOpen ? (
          <View style={styles.filterPanel}>
            <View
              style={[
                styles.searchRow,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
              ]}
            >
              <Ionicons name="search" size={16} color={colors.textSecondary} />
              <TextInput
                value={filterQuery}
                onChangeText={setFilterQuery}
                placeholder={t('activity_search_placeholder')}
                placeholderTextColor={colors.textTertiary}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.textPrimary }]}
              />
              {filterQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setFilterQuery('')}
                  style={styles.clearBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('activity_search_clear')}
                >
                  <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
            {/* Scrolls sideways rather than wrapping: five chips in a longer
                language run past a phone's width, and a second row of them
                would push the list down further than the filter is worth. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.kindChips}
            >
              {ACTIVITY_KIND_FILTERS.map(kind => {
                const selected = filterKind === kind
                const label = t(kindFilterLabelKey(kind))
                return (
                  <TouchableOpacity
                    key={kind}
                    onPress={() => setFilterKind(kind)}
                    style={[
                      styles.kindChip,
                      selected
                        ? { backgroundColor: colors.accent, borderColor: colors.accent }
                        : { borderColor: colors.surfaceRaisedBorder }
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected }}
                  >
                    <Text
                      style={[styles.kindChipLabel, { color: selected ? colors.textOnAccent : colors.textSecondary }]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>
    ),
    [
      colors,
      t,
      onExport,
      exporting,
      actions.length,
      filterOpen,
      filterQuery,
      filterKind,
      toggleFilter,
      pendingResends.length,
      stuckBadges,
      resending,
      onResendPending,
      online,
      queuedCount,
      rejected,
      sentRejected,
      queuedSent,
      stalled,
      pendingCount,
      pendingStuck,
      pendingCorrupt,
      onRequestAgain,
      onCopyDetails,
      onDismiss,
      onSendAgain,
      mandala.stuck,
      stuckIssuerName
    ]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenGradient from={colors.canvasTop} to={colors.canvasBase} height={360} />

      {/* Settings is the only permanent fixture up here: it is navigation
          chrome, not a money action, so it should not compete with Pay and
          Vault for the eye. Connections moved into Settings as "Connect to
          App" — pairing a desktop app is a once-in-a-while errand, not a
          home-screen affordance.
          Once a token is held, the coin switcher (design 4a, 2026-09-16)
          takes the centre column as a filled pill — the screen's title IS
          the control that changes what the screen is showing, rather than a
          plain label buried in the balance block below. Both side columns
          share `iconBtn`'s width so the pill centres over an empty slot too,
          not just when a host supplies `topLeft`. */}
      <View style={styles.header} onLayout={e => setHeaderHeight(e.nativeEvent.layout.height)}>
        <View style={styles.headerSide}>{topLeft}</View>
        <View style={styles.headerCenter}>
          {hasTokens && (
            <TouchableOpacity
              onPress={() => setSwitcherOpen(true)}
              activeOpacity={0.7}
              hitSlop={8}
              style={[styles.switcherPill, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={t('wallet_coin_switcher')}
            >
              <Text style={[styles.switcherPillLabel, { color: colors.textOnAccent }]} numberOfLines={1}>
                {heldAsset ? heldAsset.asset.ticker : BSV_LABEL}
              </Text>
              <Ionicons name="chevron-down" size={12} color={colors.textOnAccent} />
            </TouchableOpacity>
          )}
        </View>
        <View style={[styles.headerSide, styles.headerSideEnd]}>
          <TouchableOpacity
            onPress={() => router.push('/wallet-config')}
            style={[styles.iconBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
            accessibilityRole="button"
            accessibilityLabel={t('wallet_settings')}
          >
            <Ionicons name="settings-outline" size={17} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Renders only when the keys could not be released — a destroyed key, a
          dismissed prompt, or biometric lockout. Previously all three looked
          identical to "you have no wallet". */}
      <WalletLockNotice />

      <View onLayout={e => setPinnedHeight(e.nativeEvent.layout.height)}>{pinnedHeader}</View>

      {/* The list scrolls under this edge. The fade makes a row dissolve into
          the backdrop as it goes rather than being cut off mid-glyph. */}
      <View style={styles.listWrap}>
        <ScrollFade color={sampleScreenGradient(colors.canvasTop, colors.canvasBase, insets.top + pinnedHeight, 360)} />
        <FlatList
          data={rows}
          keyExtractor={(item, index) => (item.kind === 'day' ? item.id : `${item.txid || index}-${index}`)}
          renderItem={renderItem}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.pad} color={colors.textSecondary} />
            ) : loadError ? (
              <View style={styles.emptyError}>
                <Text style={[styles.empty, { color: colors.textSecondary, padding: 0 }]}>
                  {t('activity_load_failed')}
                </Text>
                <PressableScale
                  onPress={() => {
                    setLoadError(false)
                    setFocusVersion(v => v + 1)
                  }}
                  haptic="tap"
                  style={styles.emptyRetry}
                  accessibilityRole="button"
                  accessibilityLabel={t('activity_load_retry')}
                >
                  <Text style={[styles.emptyRetryLabel, { color: colors.accent }]}>{t('activity_load_retry')}</Text>
                </PressableScale>
              </View>
            ) : filterActive ? (
              // Nothing found YET is not nothing found: until older history
              // is spent, the search is still paging through it.
              historyExhausted || olderPageFailed ? (
                <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('activity_filter_no_match')}</Text>
              ) : (
                <ActivityIndicator style={styles.pad} color={colors.textSecondary} />
              )
            ) : (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {heldAsset
                  ? t('wallet_activity_empty_asset', { ticker: heldAsset.asset.ticker })
                  : t('no_transactions')}
              </Text>
            )
          }
          // The filter's search field lives in the header: a tap on a chip
          // or a row must land the first time, not just drop the keyboard.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListFooterComponent={
            // One container of FIXED height in both states. Swapping a short
            // spinner for a tall spacer changed the content height every time a
            // page load started/ended, which made FlatList re-evaluate and re-fire
            // onEndReached — feeding the loop the guards above now break.
            <View style={[styles.footer, { height: insets.bottom + spacing.xxxl }]}>
              {loadingMore ? <ActivityIndicator color={colors.textSecondary} /> : null}
            </View>
          }
        />
      </View>

      <BackupReminderSheet
        visible={showBackupReminder}
        onClose={() => setShowBackupReminder(false)}
        onBackupNow={() => {
          setShowBackupReminder(false)
          router.push('/auth/mnemonic?flow=backup')
        }}
      />

      <BiometricAdvisoryModal
        visible={showBiometricAdvisory}
        loading={creatingWalletFromAdvisory}
        onCancel={() => {
          setShowBiometricAdvisory(false)
          setPendingDestination(null)
        }}
        onContinue={() => {
          // Kept up (with a spinner in place of the label) until wallet
          // creation actually settles: recoverMnemonicWallet's PBKDF2/BIP32
          // math is real, blocking JS-thread work, and dismissing the modal
          // immediately here left the screen looking frozen for that whole
          // stretch, with nothing on screen explaining why.
          setCreatingWalletFromAdvisory(true)
          const destination = pendingDestination
          ;(async () => {
            try {
              // ensureWalletExists' generateMnemonicWallet/recoverMnemonicWallet
              // math starts running synchronously on this same tick — without
              // yielding first, that blocking work could start before React
              // ever got to paint the spinner just requested above, making the
              // tap look like it did nothing.
              await new Promise(resolve => setTimeout(resolve, 0))
              const created = await ensureWalletExists()
              setShowBiometricAdvisory(false)
              setPendingDestination(null)
              if (created && destination) router.push(destination as Parameters<typeof router.push>[0])
            } finally {
              setCreatingWalletFromAdvisory(false)
            }
          })()
        }}
      />

      {/* One transaction, full screen. Rendered here rather than behind its
          own route so the overflow menu can reach the very handlers the rows
          use — including the overlay-authoritative cancel — instead of a
          duplicate of them. */}
      <SlideOverFromRight visible={openTx !== null} onClosed={() => setClosedTx(null)}>
        {(openTx ?? closedTx) ? (
          <TransactionDetailScreen
            tx={detailParams((openTx ?? closedTx)!)}
            getActions={() => detailActions((openTx ?? closedTx)!)}
            onBack={() => setOpenTx(null)}
          />
        ) : null}
      </SlideOverFromRight>

      <ImportFromBackupPrompt
        visible={!hasWallet && secretsReady && !walletBuilding && knownNoStoredIdentity}
        onImport={() => router.push('/auth/mnemonic?flow=import')}
      />

      {/* Mounted only once a token is held: a wallet without one keeps today's tree. */}
      {hasTokens && (
        <AssetSwitcherDropdown
          visible={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
          top={insets.top + headerHeight}
          balances={mandala.balances ?? []}
          selected={heldAsset ? heldAsset.asset.assetId : null}
          onSelect={setSelectedAssetId}
          bsv={balanceParts}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // No bottom rule: the gradient already separates the chrome from the balance,
  // and a hairline there cut the screen in half above the focal figure.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  // Both sides share the settings icon's width, so the centre column (the
  // switcher pill, when it's there) stays centred whether or not a host
  // supplies `topLeft` — an empty slot is still a slot the same size.
  headerSide: { minWidth: 34, alignItems: 'flex-start', justifyContent: 'center' },
  headerSideEnd: { alignItems: 'flex-end' },
  headerCenter: { flex: 1, alignItems: 'center' },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The switcher pill (design 4a): filled with the accent colour so it reads
  // as the screen's title AND its primary control, not a secondary label.
  switcherPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: radii.pill
  },
  switcherPillLabel: {
    ...typography.headline,
    fontWeight: '700'
  },
  balanceBlock: {
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl
  },
  // Uppercase + wide tracking: this is a column heading over a figure, not a
  // phrase leading into it. Scripts without case ignore the transform.
  // Sentence case, not the uppercase eyebrow treatment: "You have" is a phrase
  // leading into the figure, and caps would read as shouting rather than as a
  // label.
  balanceLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2
  },
  balanceSpinner: { marginTop: spacing.md },
  // tabular-nums keeps the figure from jittering as digits change.
  balance: {
    ...typography.display,
    lineHeight: 46,
    letterSpacing: -1.2,
    marginTop: 10,
    fontVariant: ['tabular-nums']
  },
  // `flex-start` is what hangs the minor units from the top of the figure's
  // line box; `baseline` would drop them back onto the baseline and undo it.
  balanceRow: { flexDirection: 'row', alignItems: 'flex-start' },
  /**
   * Roughly 55% of the display size — smaller than the major unit, larger than
   * a true superscript, which at 44pt would be unreadable. `marginTop` matches
   * the major run's so the two line boxes start together.
   */
  balanceFraction: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginTop: 10,
    fontVariant: ['tabular-nums']
  },
  balanceUnit: { fontSize: 19, fontWeight: '600', letterSpacing: 0 },
  balanceContext: { fontSize: 13, lineHeight: 18, marginTop: 10, fontVariant: ['tabular-nums'] },

  destinations: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.xl,
    // Breathing room under the buttons, so the first activity row fades in
    // below them instead of arriving hard against their edge.
    paddingBottom: spacing.lg
  },
  listWrap: { flex: 1 },
  dest: {
    flex: 1,
    // Icon sits beside the label, not above it, so all three destinations read
    // as one horizontal row of controls.
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.pill,
    paddingTop: 15,
    paddingBottom: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent'
  },
  // The one accent-filled control on the screen, so it also gets the only
  // shadow — the two cues have to agree about what is primary.
  destPrimary: {
    borderColor: 'transparent',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4
  },
  destLabel: { fontSize: 13, fontWeight: '600' },
  destLabelPrimary: { fontWeight: '700' },
  resendBanner: { paddingTop: spacing.xl },
  resendTrailing: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  resendAction: { fontSize: 15, fontWeight: '600' },

  activityHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: 28,
    paddingBottom: 10
  },
  activityTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  activityTools: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // Same height as the Export pill beside it, so the two read as one set.
  filterBtn: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: 11,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  exportLabel: { fontSize: 12, fontWeight: '600' },

  // The chip row scrolls edge to edge, so only the search field is inset.
  filterPanel: { gap: spacing.md, paddingBottom: spacing.sm },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.xl,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  searchInput: { ...typography.subhead, flex: 1, paddingVertical: spacing.sm, paddingHorizontal: 0 },
  clearBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  kindChips: { gap: spacing.sm, paddingHorizontal: spacing.xl },
  kindChip: {
    height: 30,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center'
  },
  kindChipLabel: { fontSize: 13, fontWeight: '600' },

  dayHeader: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.xl,
    paddingTop: 14,
    paddingBottom: 4
  },

  pad: { padding: spacing.xl },
  footer: { alignItems: 'center', justifyContent: 'center' },
  empty: { ...typography.subhead, textAlign: 'center', padding: spacing.xxxl },
  emptyError: { alignItems: 'center', padding: spacing.xxxl, gap: spacing.md },
  emptyRetry: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  emptyRetryLabel: { fontSize: 15, fontWeight: '600' }
})
