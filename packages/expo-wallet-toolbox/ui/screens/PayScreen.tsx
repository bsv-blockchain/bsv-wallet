/**
 * Pay — one screen, six cells.
 *
 * Direction is the primary axis because it is the first thing a user knows
 * about their own situation; who the counterparty is comes second, and IT is
 * what determines the rail. The user never picks a transport: see
 * utils/pay/rails/index.ts, where the rail is inferred from how the
 * counterparty was identified.
 *
 * Replaces /payments, /legacy-payments, /local-payments and the Identity Key
 * modal in settings.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { I18nManager, InteractionManager, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'

import PressableScale from '../components/ui/PressableScale'
import PayCellRow from '../components/pay/PayCellRow'
import NearbyFlow from '../components/pay/NearbyFlow'
import { partitionQueueByGrace } from '../../core/offline/queueGrace'
import PaymentQrDisplay from '../components/pay/PaymentQrDisplay'
import HandleSend from '../components/pay/HandleSend'
import HandleReceive from '../components/pay/HandleReceive'
import AddressSend from '../components/pay/AddressSend'
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
  isPayCell,
  type PayCell,
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

interface CellSpec {
  cell: PayCell
  titleKey: string
  subtitleKey: string
  icon: keyof IoniconsComponent['glyphMap']
}

const CELLS: Record<Direction, CellSpec[]> = {
  pay: [
    {
      cell: 'pay-nearby',
      titleKey: 'pay_cell_nearby_pay',
      subtitleKey: 'pay_cell_nearby_pay_sub',
      icon: 'scan-outline'
    },
    {
      cell: 'pay-handle',
      titleKey: 'pay_cell_handle_pay',
      subtitleKey: 'pay_cell_handle_pay_sub',
      icon: 'person-outline'
    },
    {
      cell: 'pay-address',
      titleKey: 'pay_cell_address_pay',
      subtitleKey: 'pay_cell_address_pay_sub',
      icon: 'wallet-outline'
    }
  ],
  get: [
    {
      cell: 'get-nearby',
      titleKey: 'pay_cell_nearby_get',
      subtitleKey: 'pay_cell_nearby_get_sub',
      icon: 'qr-code-outline'
    },
    {
      cell: 'get-handle',
      titleKey: 'pay_cell_handle_get',
      subtitleKey: 'pay_cell_handle_get_sub',
      icon: 'person-outline'
    },
    {
      cell: 'get-address',
      titleKey: 'pay_cell_address_get',
      subtitleKey: 'pay_cell_address_get_sub',
      icon: 'wallet-outline'
    }
  ]
}

const CELL_TITLE_KEYS: Record<PayCell, string> = {
  'pay-nearby': 'pay_cell_nearby_pay',
  'pay-handle': 'pay_cell_handle_pay',
  'pay-address': 'pay_cell_address_pay',
  'get-nearby': 'pay_cell_nearby_get',
  'get-handle': 'pay_cell_handle_get',
  'get-address': 'pay_cell_address_get'
}

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

  const paramCell = firstParam(params.cell)
  // A peerpay link is a request to pay a handle, whatever cell was named.
  const openingCell: PayCell | null = peerpay ? 'pay-handle' : isPayCell(paramCell) ? paramCell : null

  // Fixed by how the user got here, not switchable on-screen: a named cell
  // implies its own direction, and `?direction=get` opens the receive side on
  // its CHOOSER (no cell), which is what the wallet's "Get paid" button wants —
  // the transport is still the user's to pick.
  const direction: Direction = openingCell
    ? openingCell.startsWith('get')
      ? 'get'
      : 'pay'
    : firstParam(params.direction) === 'get'
      ? 'get'
      : 'pay'
  const [cell, setCell] = useState<PayCell | null>(openingCell)

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
  const isNearbyCell = cell === 'pay-nearby' || cell === 'get-nearby'

  // Refreshed whenever the wallet finishes building, connectivity changes, or
  // the user enters/leaves a pay cell: the queue only moves when the network
  // state does or when a cell just queued a row (e.g. an in-session offline
  // QR Done), so there is no need to poll it on every render. `cell` is a
  // cheap local SQLite read, not a network round-trip, so re-running it on
  // every cell transition is fine — returning from a pay cell must pick up
  // rows the cell just queued.
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
        // not break the rest of the screen — the grid still has to render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [walletBuilt, storage, online, txStatusVersion, walletUserId, cell, queueNonce])

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
   * the chooser grid. The grid is a decision the user already made on the way
   * in; stepping back through it makes leaving a two- or three-tap affair.
   *
   * `dismissTo` pops to the wallet when it is in the stack (the normal case)
   * and replaces this screen with it when /pay was deep-linked into directly.
   * Not `navigate`: that re-pushes the wallet above the very cells this is
   * trying to leave behind, which puts them one edge-swipe away instead of
   * discarding them.
   */
  const goBack = useCallback(() => {
    router.dismissTo('/')
  }, [])

  const grid = () => (
    <View style={styles.grid}>
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
      {/* No direction switcher here: the user already chose Pay or Get paid to
          get to this screen, and the header title says which one they are in.
          Offering the toggle again would ask a question they just answered. */}
      <View style={styles.rows}>
        {CELLS[direction].map(spec => {
          // Handle needs a message box round-trip and address needs an overlay
          // lookup; neither works underground. Nearby is the whole point of
          // being offline — it is the one rail this whole feature was built for.
          const needsInternet = !spec.cell.endsWith('nearby')
          const disabled = !online && needsInternet
          return (
            <PayCellRow
              key={spec.cell}
              title={t(spec.titleKey)}
              subtitle={disabled ? t('pay_offline_needs_internet') : t(spec.subtitleKey)}
              icon={spec.icon}
              disabled={disabled}
              onPress={() => setCell(spec.cell)}
            />
          )
        })}
      </View>
    </View>
  )

  const body = () => {
    switch (cell) {
      case 'pay-nearby':
        return nearbyAdvisorySeen ? <NearbyFlow role="payer" onExit={goBack} /> : null
      case 'get-nearby':
        return nearbyAdvisorySeen ? <NearbyFlow role="payee" onExit={goBack} /> : null
      case 'pay-handle':
        return (
          <HandleSend initialIdentityKey={initialIdentityKey} initialSats={initialSats} initialNotice={peerPayNotice} />
        )
      case 'get-handle':
        return <HandleReceive />
      case 'pay-address':
        return <AddressSend />
      case 'get-address':
        return <AddressReceive />
      default:
        return grid()
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
          {/* Inside a rail, the rail names itself. Otherwise the title carries
              the direction, since the switcher that used to show it is gone. */}
          {cell ? t(CELL_TITLE_KEYS[cell]) : t(direction === 'pay' ? 'pay_direction_pay' : 'pay_direction_receive')}
        </Text>
        <View style={styles.headerBtn} />
      </View>
      {/* The grid sits on the secondary background so its elevated rows read as
          cards — on `background` they would be white-on-white in light mode and
          separated by a hairline alone. A cell body is a form, not a card list,
          so it gets the plain background the rest of the app's forms use. */}
      <View style={[styles.bodyWrap, { backgroundColor: cell ? colors.background : colors.backgroundSecondary }]}>
        {body()}
      </View>
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
        onCancel={() => setCell(null)}
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
  grid: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  rows: { gap: spacing.md },
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
