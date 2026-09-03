/**
 * Pay — two screens, no chooser.
 *
 * Pay opens on one send form whose recipient field infers the rail from what
 * is typed or scanned (see core/pay/rails: classifyRecipientInput,
 * classifyScan). A scanned nearby-session code swaps the form for NearbyFlow.
 *
 * Get paid opens on the request hub: the amount first, then three method
 * rows, each of which shows that method's code with the amount carried in.
 *
 * `?cell=` values survive as deep-link aliases: any `pay-*` opens the send form
 * (`pay-nearby` with the scanner up), any `get-*` opens that method directly.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { I18nManager, InteractionManager, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'

import PressableScale from '../components/ui/PressableScale'
import { partitionQueueByGrace } from '../../core/offline/queueGrace'
import PaymentQrDisplay from '../components/pay/PaymentQrDisplay'
import UniversalSend from '../components/pay/UniversalSend'
import RequestHub, { requestSatsFrom, type RequestMethod } from '../components/pay/RequestHub'
import NearbyFlow from '../components/pay/NearbyFlow'
import HandleReceive from '../components/pay/HandleReceive'
import AddressReceive from '../components/pay/AddressReceive'
import OfflineNotice from '../components/pay/OfflineNotice'
import { useOnline } from '../hooks/useOnline'
import { useOfflineNoticeActions } from '../hooks/useOfflineNoticeActions'
import {
  useTheme,
  spacing,
  typography,
  useWallet,
  validatePeerPayURI,
  type Session,
  takeProofNudge,
  findOfflineActions,
  type OfflineActionRow,
  TaskSendOffline
} from '@bsv/expo-wallet-toolbox'
import { getPendingCorruptNotice, readUnprocessedPending } from '../../core/localpay/pending'
import { nearbyAdvisory } from '../../core/localpay/nearbyAdvisory'
import { NearbyAdvisoryModal } from '../components/pay/NearbyAdvisoryModal'

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
 * expo-router load.
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

type Direction = 'pay' | 'get'

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const METHOD_TITLE_KEYS: Record<RequestMethod, string> = {
  'get-nearby': 'pay_method_nearby',
  'get-handle': 'pay_method_remote_link',
  'get-address': 'pay_method_address'
}

const isRequestMethod = (v: string | undefined): v is RequestMethod =>
  v === 'get-nearby' || v === 'get-handle' || v === 'get-address'

export function PayScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const insets = useSafeAreaInsets()
  const online = useOnline()
  const {
    walletBuilding,
    walletBuilt,
    storage,
    txStatusVersion,
    walletUserId,
    runMonitorTask,
    managers,
    adminOriginator
  } = useWallet()
  const [queued, setQueued] = useState(0)
  const [rejected, setRejected] = useState<OfflineActionRow[]>([])
  const [sentRejected, setSentRejected] = useState<OfflineActionRow[]>([])
  const [queuedSentRows, setQueuedSentRows] = useState<OfflineActionRow[]>([])
  /** When to re-read the queue because a young row will have aged past its grace. */
  const [graceDelay, setGraceDelay] = useState<number | undefined>(undefined)
  const [stalled, setStalled] = useState<string | undefined>(undefined)
  const [pendingCount, setPendingCount] = useState(0)
  const [pendingStuck, setPendingStuck] = useState(0)
  const [pendingCorrupt, setPendingCorrupt] = useState(false)
  const [showCode, setShowCode] = useState<OfflineActionRow | null>(null)
  const [queueNonce, setQueueNonce] = useState(0)

  const params = useLocalSearchParams<{
    cell?: string | string[]
    direction?: string | string[]
    identityKey?: string | string[]
    sats?: string | string[]
    peerpay?: string | string[]
  }>()

  const peerpay = firstParam(params.peerpay)
  const peerPayValidation = useMemo(() => (peerpay ? validatePeerPayURI(peerpay) : null), [peerpay])
  const peerPayNotice = useMemo(() => {
    if (!peerPayValidation) return null
    const messages = [peerPayValidation.errors.identityKey, peerPayValidation.errors.sats].filter(Boolean)
    return messages.length ? messages.join('. ') : null
  }, [peerPayValidation])

  const initialIdentityKey = peerPayValidation?.identityKey ?? firstParam(params.identityKey)
  const satsParam = peerPayValidation?.sats ?? Number(firstParam(params.sats))
  const initialSats = Number.isFinite(satsParam) && satsParam > 0 ? Number(satsParam) : undefined
  // Memoized: useRecipientInput re-adopts initialTarget whenever its identity changes.
  const initialTarget = useMemo(
    () =>
      initialIdentityKey
        ? {
            kind: 'handle' as const,
            identityKey: initialIdentityKey,
            ...(peerPayValidation?.messageBoxUrl ? { messageBoxUrl: peerPayValidation.messageBoxUrl } : {})
          }
        : undefined,
    [initialIdentityKey, peerPayValidation?.messageBoxUrl]
  )

  const paramCell = firstParam(params.cell)
  // Direction is fixed by how the user got here. A peerpay link is a request
  // to pay; a `get-*` cell or `?direction=get` is the receive side.
  const direction: Direction =
    peerpay || (paramCell ?? '').startsWith('pay')
      ? 'pay'
      : isRequestMethod(paramCell) || firstParam(params.direction) === 'get'
        ? 'get'
        : 'pay'
  /** Pay side: a scanned nearby session takes over the screen. */
  const [nearbySession, setNearbySession] = useState<Session | null>(null)
  /** Get side: the method chosen on the hub, or named by a deep link. */
  const [method, setMethod] = useState<RequestMethod | null>(
    direction === 'get' && isRequestMethod(paramCell) ? paramCell : null
  )
  /** Get side: the hub's raw amount, carried into the method. */
  const [requestSats, setRequestSats] = useState('')
  // One camera raise per deep link; a cancelled advisory must not re-open it.
  const [scanOnMount, setScanOnMount] = useState(paramCell === 'pay-nearby')

  // ── nearby advisory ─────────────────────────────────────────────────
  /**
   * Nearby pay/get-paid triggers OS-level prompts (iOS Local Network access;
   * Android Bluetooth/nearby-Wi-Fi permissions) as soon as NearbyFlow mounts,
   * with no gesture of its own to explain them. null = not loaded yet (block
   * mounting NearbyFlow, but don't show the modal either — avoids a flash for
   * a returning user whose flag is about to come back true).
   */
  const [nearbyAdvisorySeen, setNearbyAdvisorySeen] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void nearbyAdvisory.get().then(seen => {
      if (!cancelled) setNearbyAdvisorySeen(seen)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const isNearbyCell = (direction === 'pay' && nearbySession !== null) || method === 'get-nearby'

  // Refreshed whenever the wallet finishes building, connectivity changes, or
  // the user enters/leaves a method or a nearby session: the queue only moves
  // when the network state does or when one of those just queued a row (e.g.
  // an in-session offline QR Done), so there is no need to poll it on every
  // render. It is a cheap local SQLite read, not a network round-trip, so
  // re-running it on every such transition is fine — returning from a method
  // or a nearby session must pick up rows it just queued.
  useEffect(() => {
    if (!walletBuilt) return
    let cancelled = false
    void (async () => {
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
          status: ['queued', 'posting', 'rejected'],
          ...(walletUserId === null ? {} : { userId: walletUserId })
        })
        if (cancelled) return
        // Same grace as the wallet screen: online, a payment the drain is about
        // to post is not news, and the banner flashing up for the half second
        // before it lands reads as a fault that is not there.
        const live = partitionQueueByGrace(
          rows.filter(r => r.status !== 'rejected'),
          { online, nowMs: Date.now() }
        )
        setQueued(live.shown.length)
        setGraceDelay(live.nextCheckMs)
        // 'sent'-role rows can be rejected too (a payer's own held payment can be
        // poisoned), but they carry no senderIdentityKey or receivedVia — those
        // are only ever recorded on the receiving side (see
        // storage/StorageExpoSQLite.ts's holdReqsOffline, and
        // utils/localpay/pending.ts's processPending, which backfills them
        // after the fact). Showing one through OfflineNotice's "who handed you
        // this" copy would misreport the user's own failed payment as someone
        // else's fraud against them, so it gets its own unattributed notice.
        setRejected(rows.filter(r => r.status === 'rejected' && r.role === 'received'))
        setSentRejected(rows.filter(r => r.status === 'rejected' && r.role === 'sent'))
        setQueuedSentRows(live.shown.filter(r => r.role === 'sent'))
        setStalled(TaskSendOffline.lastStall)
      } catch {
        // This banner is advisory, never load-bearing. A read failure here must
        // not break the rest of the screen — the send form or hub still has to render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [walletBuilt, storage, online, txStatusVersion, walletUserId, method, nearbySession, queueNonce])

  const reloadQueue = useCallback(() => setQueueNonce(n => n + 1), [])

  // A row that is merely young becomes newsworthy by the passage of time alone.
  useEffect(() => {
    if (graceDelay === undefined) return
    const t = setTimeout(reloadQueue, graceDelay + 100)
    return () => clearTimeout(t)
  }, [graceDelay, reloadQueue])
  const pushPay = useCallback((sats?: number) => {
    const { router: r } = loadExpoRouter()
    if (typeof r.setParams === 'function') {
      r.setParams(sats && sats > 0 ? { sats: String(sats) } : { sats: undefined })
      return
    }
    r.push(sats && sats > 0 ? `/pay?sats=${sats}` : '/pay')
  }, [])
  const { onRequestAgain, onCopyDetails, onDismiss, onSendAgain } = useOfflineNoticeActions({
    storage,
    permissionsManager: managers?.permissionsManager,
    adminOriginator: adminOriginator ?? '',
    online,
    rejected,
    t,
    reload: reloadQueue,
    pushPay
  })

  // Auth failed while this screen was open (the wallet finished building and
  // there is no wallet) — same guard the old payments screen carried.
  const prevBuilding = React.useRef(walletBuilding)
  useEffect(() => {
    const wasBuilding = prevBuilding.current
    prevBuilding.current = walletBuilding
    if (wasBuilding && !walletBuilding && !walletBuilt) {
      if (router.canGoBack()) router.back()
      else router.replace('/')
    }
  }, [walletBuilding, walletBuilt])

  // One deferred proof sweep per visit (10-min gated): see utils/pay/proofNudge.ts.
  useEffect(() => {
    if (!online) return
    const task = InteractionManager.runAfterInteractions(() => {
      if (!takeProofNudge(Date.now())) return
      runMonitorTask('CheckForProofs').catch(() => {
        // Best-effort by design: a failed sweep leaves the 2h background
        // trigger as the backstop, and must never surface on this screen.
      })
    })
    return () => task.cancel()
  }, [online, runMonitorTask])

  /**
   * Back from anywhere on this screen means "back to the wallet" — never to
   * an intermediate screen. The hub or the send form is a decision the user
   * already made on the way in; stepping back through it makes leaving a
   * two- or three-tap affair.
   *
   * `dismissTo` pops to the wallet when it is in the stack (the normal case)
   * and replaces this screen with it when /pay was deep-linked into directly.
   * Not `navigate`: that re-pushes the wallet above the very screens this is
   * trying to leave behind, which puts them one edge-swipe away instead of
   * discarding them.
   */
  const goBack = useCallback(() => {
    router.dismissTo('/')
  }, [])

  const onNearbySession = useCallback((session: Session) => {
    // One camera raise per deep link; a cancelled advisory must not re-open it.
    setScanOnMount(false)
    setNearbySession(session)
  }, [])

  const offlineNotice = (
    <View style={styles.noticeWrap}>
      <OfflineNotice
        online={online}
        queued={queued}
        rejected={rejected}
        sentRejected={sentRejected}
        onSendNow={() => TaskSendOffline.requestNow()}
        stalled={stalled}
        pendingCount={pendingCount}
        pendingStuck={pendingStuck}
        pendingCorrupt={pendingCorrupt}
        queuedSent={queuedSentRows}
        onShowCode={setShowCode}
        onRequestAgain={row => void onRequestAgain(row)}
        onCopyDetails={onCopyDetails}
        onDismiss={row => void onDismiss(row)}
        onSendAgain={row => void onSendAgain(row)}
      />
    </View>
  )

  const body = () => {
    if (direction === 'pay') {
      if (nearbySession) {
        return nearbyAdvisorySeen ? <NearbyFlow role="payer" initialSession={nearbySession} onExit={goBack} /> : null
      }
      return (
        <>
          {offlineNotice}
          <UniversalSend
            initialTarget={initialTarget}
            initialSats={initialSats}
            initialNotice={peerPayNotice}
            openScannerOnMount={scanOnMount}
            onNearbySession={onNearbySession}
          />
        </>
      )
    }
    const sats = requestSatsFrom(requestSats)
    switch (method) {
      case 'get-nearby':
        return nearbyAdvisorySeen ? <NearbyFlow role="payee" initialRequest={{ sats }} onExit={goBack} /> : null
      case 'get-handle':
        return <HandleReceive initialSats={sats} />
      case 'get-address':
        return <AddressReceive initialSats={sats} />
      default:
        return (
          <>
            {offlineNotice}
            <RequestHub
              requestSats={requestSats}
              onChangeRequestSats={setRequestSats}
              onPick={setMethod}
              online={online}
            />
          </>
        )
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <PressableScale
          onPress={goBack}
          haptic="tap"
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('go_back')}
        >
          <Ionicons
            name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'}
            size={24}
            color={colors.textSecondary}
          />
        </PressableScale>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {/* The screen names what it is doing: the direction, or the rail/method once one is live. */}
          {direction === 'pay'
            ? t(nearbySession ? 'pay_cell_nearby_pay' : 'pay_direction_pay')
            : t(method ? METHOD_TITLE_KEYS[method] : 'local_pay_request')}
        </Text>
        <View style={styles.headerBtn} />
      </View>
      {/* Both entry screens are forms now; the hub's rows carry their own elevation. */}
      <View style={[styles.bodyWrap, { backgroundColor: colors.background }]}>{body()}</View>
      <Modal visible={!!showCode} animationType="slide" transparent onRequestClose={() => setShowCode(null)}>
        <View style={styles.codeOverlay}>
          <View style={[styles.codeCard, { backgroundColor: colors.backgroundElevated }]}>
            {showCode?.framePayload ? (
              <PaymentQrDisplay frameQr={showCode.framePayload} size={288} />
            ) : (
              <Text style={{ color: colors.textSecondary }}>{t('local_pay_too_large')}</Text>
            )}
            <TouchableOpacity onPress={() => setShowCode(null)} style={styles.codeClose}>
              <Text style={{ color: colors.info }}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <NearbyAdvisoryModal
        visible={isNearbyCell && nearbyAdvisorySeen === false}
        onCancel={() => {
          // Whichever side raised it, cancelling leaves no nearby state behind.
          setNearbySession(null)
          setMethod(null)
        }}
        onContinue={() => {
          void nearbyAdvisory.set()
          setNearbyAdvisorySeen(true)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600', flex: 1, textAlign: 'center' },
  bodyWrap: { flex: 1 },
  noticeWrap: { paddingHorizontal: spacing.lg },
  codeOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)'
  },
  codeCard: {
    padding: spacing.xl,
    borderRadius: 16,
    alignItems: 'center',
    gap: spacing.lg
  },
  codeClose: { padding: spacing.md }
})
