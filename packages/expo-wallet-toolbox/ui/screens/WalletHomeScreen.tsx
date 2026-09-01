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
import React, { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react'
import {
  View,
  Text,
  FlatList,
  StyleSheet,
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
  formatAmount,
  formatSatoshisAsBsvDecimal,
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
  type PendingResend
} from '@bsv/expo-wallet-toolbox'
import ActivityRow, { type ActivityAction } from '../components/wallet/ActivityRow'
import { cancelParkedPayment, type CancelParkedWallet } from '../../core/offline/cancelParked'
import { releaseParkedPayment } from '../../core/offline/payerHold'
import { partitionQueueByGrace } from '../../core/offline/queueGrace'
import { makeMetadataDecryptor } from '../../core/peerpay/metadataDecryptor'
import { getPendingCorruptNotice, readUnprocessedPending } from '../../core/localpay/pending'
import { homeBadges } from './homeBadges'
import { exportTransactionsAsCsv } from '../exportTransactions'
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

export function WalletHomeScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router, useFocusEffect } = loadExpoRouter()
  const Ionicons = loadIonicons()
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
    configStatus,
    walletBuilding,
    walletBuilt
  } = useWallet()
  const { unlockState } = useLocalStorage()
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'
  const online = useOnline()

  // ── onboarding gate ─────────────────────────────────────────────────
  /**
   * A fresh install has no mnemonic and no recovered key, so the auto-build
   * effect in WalletContext finishes with walletBuilt=false and nothing to
   * show — this screen would otherwise spin forever (no wallet, no error).
   * WalletLockNotice already covers a RETURNING user whose key the OS
   * destroyed or who cancelled the biometric prompt ('lost' / 'cancelled' /
   * 'unavailable'); this covers the one case it doesn't: nothing was ever
   * stored here at all.
   *
   * `unlockState.status` only becomes the literal 'absent' once an unlock has
   * actually been attempted (services/secrets/kek.ts doUnlock) — and on a
   * true fresh install that never happens, because getMnemonic/getRecoveredKey
   * short-circuit on `hasSecret` before ever calling ensureUnlocked. So the
   * status simply stays at its 'locked' module default forever. Once the
   * build attempt has genuinely concluded (walletBuilding false, walletBuilt
   * false), 'locked' and 'absent' both mean the same thing here: no secret
   * was ever found. sawBuildAttemptRef guards against the single-render race
   * where configStatus flips to 'configured' a tick before WalletContext's
   * own effect sets walletBuilding=true — without it, that transient
   * (false, false) reading would look identical to "settled, nothing found"
   * and could bounce a normal returning user into onboarding.
   */
  const sawBuildAttemptRef = useRef(false)
  const redirectedToOnboardingRef = useRef(false)
  useEffect(() => {
    if (walletBuilding) sawBuildAttemptRef.current = true
    if (redirectedToOnboardingRef.current) return
    if (!sawBuildAttemptRef.current) return
    if (walletBuilding || walletBuilt) return
    if (configStatus !== 'configured') return
    if (unlockState.status !== 'absent' && unlockState.status !== 'locked') return
    redirectedToOnboardingRef.current = true
    router.replace('/auth/mnemonic')
  }, [walletBuilding, walletBuilt, configStatus, unlockState.status])

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const [balance, setBalance] = useState<number | null>(null)
  const [actions, setActions] = useState<ActivityAction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [offlineByTxid, setOfflineByTxid] = useState<Map<string, OfflineActionRow>>(new Map())
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
  /** Synchronous in-flight latch for loadMore (state updates are async). */
  const inFlightRef = useRef(false)

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
        // Straight to our own SQLite, deliberately NOT through the wallet's
        // listOutputs: every call through WalletStorageManager queues on one
        // FIFO reader lock, and the monitor holds that lock across network
        // broadcasts — so this read used to wait on whatever the monitor was
        // doing rather than on the database. See storage/methods/walletBalanceSql.
        // The wallet's own path stays as the fallback for the window before
        // storage and the user id are known.
        let total: number | null = null
        if (storage && walletUserId != null) {
          total = await readWalletBalance(storage, walletUserId)
        }
        if (total == null) {
          const pm = managers.permissionsManager
          if (!pm) return
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
  }, [storage, walletUserId, managers.permissionsManager, adminOriginator, balanceCacheKey])

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
  // Either route to a figure counts: the direct read needs storage and the user
  // id, the fallback needs the permissions manager.
  const hasWallet = (storage != null && walletUserId != null) || managers.permissionsManager != null

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
  }, [balanceCacheKey, hasWallet])

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
    [managers.permissionsManager, adminOriginator]
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
      if (actions.length === 0) setLoading(true)
      try {
        const result = await fetchActions(0)
        if (cancelled || !result) return
        setActions(result.actions as ActivityAction[])
        offsetRef.current = result.actions.length
        // A fresh first page may have more behind it again.
        exhaustedRef.current = result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0)
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
  }, [fetchActions, txStatusVersion, focusVersion, fetchOfflineRows, storage])

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
        exhaustedRef.current = true
      }
    } catch {
      // Keep existing rows; a failed page is not the end of the list.
    } finally {
      inFlightRef.current = false
      setLoadingMore(false)
    }
  }, [fetchActions, loading])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [result, , , entries] = await Promise.all([
        fetchActions(0),
        refreshBalance(),
        fetchOfflineRows(),
        storage ? getOutboxEntries(storage) : Promise.resolve([])
      ])
      if (result) {
        setActions(result.actions as ActivityAction[])
        offsetRef.current = result.actions.length
        exhaustedRef.current = result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0)
      }
      setAttentionCount(TaskCreditInbox.lastAttentionCount)
      setUnsentCount(unsentEntries(entries).length)
    } catch {
      // loadError is set by fetchActions for a first-page failure.
    } finally {
      setRefreshing(false)
    }
  }, [fetchActions, refreshBalance, fetchOfflineRows, storage])

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
        const outcome = await resendPaymentDetails({
          client,
          storage,
          txid,
          listPeerPayAction: makeListPeerPayAction(pm, adminOriginator),
          // Network first for a fresh proof; this device's own copy when the
          // network has never heard of the transaction — a nearby payment whose
          // code was never scanned is `nosend`, and that is the case a resend
          // most needs to cover.
          decryptMetadata: makeMetadataDecryptor(pm, adminOriginator),
          refetch: makeResendBeef({
            refetch: makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline }),
            storage
          })
        })
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
      }
    },
    [busyRow, managers.permissionsManager, storage, adminOriginator, selectedNetwork, offlineByTxid, onRefresh, t]
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
  const queued = useMemo(
    () => offlineRows.filter(r => r.status !== 'rejected' && r.status !== 'parked'),
    [offlineRows]
  )
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
  const stuckBadges = useMemo(
    () =>
      homeBadges({
        attention: attentionCount,
        unsent: unsentCount,
        offlineQueued: queuedCount,
        offlineRejected: rejected.length + sentRejected.length
      }).filter(b => b.kind !== 'offline'),
    [attentionCount, unsentCount, queuedCount, rejected.length, sentRejected.length]
  )
  const reloadOffline = useCallback(() => {
    void fetchOfflineRows()
  }, [fetchOfflineRows])
  const pushPay = useCallback((sats?: number) => {
    router.push(sats && sats > 0 ? `/pay?sats=${sats}` : '/pay')
  }, [])
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
  const rows = useMemo(() => withDayHeaders(actions, t), [actions, t])

  /** Cancel a parked payment: abort the action so the inputs come back, and
   * retire its queue row. Refuses once the counterparty has broadcast. */
  const onCancelParked = useCallback(
    async (txid: string) => {
      const pm = managers.permissionsManager
      if (!storage || !pm || busyRow) return
      setBusyRow(txid)
      try {
        const outcome = await cancelParkedPayment({
          storage,
          wallet: pm as unknown as CancelParkedWallet,
          originator: adminOriginator,
          txid
        })
        if (outcome === 'cancelled') showToast(t('tx_abort_success'), { type: 'success' })
        else if (outcome === 'already-sent') showToast(t('pay_parked_already_sent'), { type: 'info' })
        else showToast(t('tx_abort_failed'), { type: 'error' })
        await onRefresh()
      } catch (e: unknown) {
        showToast(e instanceof Error ? e.message : t('unknown_error'), { type: 'error' })
      } finally {
        setBusyRow(null)
      }
    },
    [storage, managers.permissionsManager, adminOriginator, busyRow, onRefresh, t]
  )

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item, index }) => {
      if (item.kind === 'day') {
        return <Text style={[styles.dayHeader, { color: colors.textTertiary }]}>{item.label}</Text>
      }
      const key = item.txid || item.reference || `row-${index}`
      const offline = item.txid ? offlineByTxid.get(item.txid) : undefined
      const busy = busyRow === item.txid || (!!item.reference && busyRow === item.reference)

      return (
        <ActivityRow
          action={item}
          rowKey={key}
          offlineStatus={offline?.status}
          expanded={expandedRow === key}
          busy={busy}
          onToggle={toggleRow}
          onExplorer={onExplorer}
          onRefreshTx={onRefreshTx}
          onAbort={onAbort}
          onSendPaymentDetails={onSendPaymentDetails}
          onSendAgain={onFailedSendAgain}
          onCancelParked={txid => void onCancelParked(txid)}
        />
      )
    },
    [
      colors,
      offlineByTxid,
      busyRow,
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
    () => (balance === null ? null : formatAmountParts(balance, currency, satoshisPerUSD, { abbreviate: true })),
    [balance, currency, satoshisPerUSD]
  )

  /** The line under the figure: the same money in the denominations the figure
   * is not using, so the user never has to convert in their head. */
  const balanceContext = useMemo(() => {
    if (balance === null) return ''
    const bsv = `${formatSatoshisAsBsvDecimal(balance)} BSV`
    const other = formatAmount(balance, currency === 'USD' ? 'BSV' : 'USD', satoshisPerUSD, {
      abbreviate: true
    })
    return `${bsv}   ·   ${other}`
  }, [balance, currency, satoshisPerUSD])

  /**
   * Pinned above the list, not part of it.
   *
   * The balance and the two destinations are what someone opens this screen
   * for; scrolling a long history used to carry them off the top, so the
   * answer to "how much do I have" and the way to pay were both a scroll back
   * up. Everything below them still scrolls with the activity it describes.
   */
  const pinnedHeader = useMemo(
    () => (
      <View>
        <TouchableOpacity
          onPress={() => void refreshBalance()}
          activeOpacity={0.7}
          style={styles.balanceBlock}
          accessibilityLabel={t('wallet_balance_refresh')}
        >
          <Text style={[styles.balanceLabel, { color: colors.textTertiary }]}>{t('wallet_balance_you_have')}</Text>
          {balanceParts === null ? (
            <ActivityIndicator color={colors.textSecondary} style={styles.balanceSpinner} />
          ) : (
            <>
              <Text style={[styles.balance, { color: colors.textPrimary }]}>
                {balanceParts.value}
                {balanceParts.unit ? (
                  <Text style={[styles.balanceUnit, { color: colors.textSecondary }]}> {balanceParts.unit}</Text>
                ) : null}
              </Text>
              <Text style={[styles.balanceContext, { color: colors.textSecondary }]}>{balanceContext}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* The destinations. Pay is the only accent-filled element on this
            screen, so the eye lands on it first. */}
        <View style={styles.destinations}>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay')}
            style={[styles.dest, styles.destPrimary, { backgroundColor: colors.accent }]}
          >
            <MaterialCommunityIcons name="arrow-top-right" size={19} color={colors.textOnAccent} />
            <Text style={[styles.destLabel, styles.destLabelPrimary, { color: colors.textOnAccent }]}>
              {t('pay_direction_pay')}
            </Text>
          </PressableScale>

          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay?direction=get')}
            style={[styles.dest, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          >
            <MaterialCommunityIcons name="arrow-bottom-left" size={19} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>{t('pay_direction_receive')}</Text>
          </PressableScale>

          {/* Vault — hidden for now; will release once R1-K1 research is complete.
          <PressableScale
            onPress={() => router.push('/vault')}
            style={[
              styles.dest,
              { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
            ]}
          >
            <MaterialCommunityIcons name="safe" size={19} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>
              {t('wallet_vault')}
            </Text>
          </PressableScale>
          */}
        </View>
      </View>
    ),
    [balanceParts, balanceContext, colors, t, refreshBalance, router]
  )

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
                        : t('home_payments_unsent', { count: badge.count })
                    }
                    icon={badge.kind === 'attention' ? 'alert-circle-outline' : 'send-outline'}
                    iconColor={colors.warning}
                    isLast={i === stuckBadges.length - 1}
                    onPress={() =>
                      router.push(badge.kind === 'attention' ? '/pay?cell=get-handle' : '/pay?cell=pay-handle')
                    }
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
              style={[styles.exportLabel, { color: actions.length === 0 ? colors.textTertiary : colors.textSecondary }]}
            >
              {t('tx_export_csv')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [
      colors,
      t,
      onExport,
      exporting,
      actions.length,
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
      onSendAgain
    ]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenGradient from={colors.canvasTop} to={colors.canvasBase} height={360} />

      {/* Settings is the only thing up here: it is navigation chrome, not a
          money action, so it should not compete with Pay and Vault for the eye.
          Connections moved into Settings as "Connect to App" — pairing a desktop
          app is a once-in-a-while errand, not a home-screen affordance. */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.push('/wallet-config')}
          style={[styles.iconBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          accessibilityRole="button"
          accessibilityLabel={t('wallet_settings')}
        >
          <Ionicons name="settings-outline" size={17} color={colors.textSecondary} />
        </TouchableOpacity>
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
            ) : (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('no_transactions')}</Text>
            )
          }
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
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: 16,
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
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
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
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  exportLabel: { fontSize: 12, fontWeight: '600' },

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
