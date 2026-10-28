/**
 * The app runtime of the Safari bridge (spec 6.7): startup order, drain triggers and the logout reset.
 * Calls are wrapped for receipts (spec 6.7); the done screen and the toast (spec 6.12) are rendered here.
 *
 * One instance runs per `native`: a Fast Refresh or provider remount shares it (reference counted), so
 * there is one processor and `recover()` runs once. After a logout reset the instance is final until
 * `native.init()` runs again; the host re-runs the startup by itself once a new wallet appears
 * (the snapshot goes `none`, then leaves it), because the app is not restarted between wallets.
 */
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppState, Linking } from 'react-native'
import { createInboxProcessor, type InboxProcessor } from '@bsv/expo-wallet-toolbox/core/bridge/inbox'
import { dispatch } from '@bsv/expo-wallet-toolbox/core/bridge/dispatcher'
import {
  getBindingRegistry,
  getBridgeSnapshot,
  getPermissionPolicy,
  isBridgeHostAttached,
  listConnectedSites,
  onConnectedSitesChange,
  onSnapshotChange,
  registerTransport,
  type TransportHandle
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { registerSessionTeardown } from '@bsv/expo-wallet-toolbox/core/context/sessionTeardown'
import { formatAmount } from '@bsv/expo-wallet-toolbox/core/amountFormatHelpers'
import { ExchangeRateContext } from '@bsv/expo-wallet-toolbox/core/context/ExchangeRateContext'
import { WalletContext } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import { usePermissionSheetBusy } from '@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet'
import type { BsvBridgeNative } from '../shared/native'
import { parseHandoffUrl } from './handoffUrl'
import { createMirrorWriter, type MirrorWriter } from './mirror'
import { createNativeInboxStore } from './nativeStore'
import { createReceiptDispatch, createReceiptTracker, type Receipt } from './receipts'
import { DoneScreen } from './ui/DoneScreen'
import { Toast } from './ui/Toast'

export const SAFARI_TRANSPORT_ID = 'safari-extension'
const SWEEP_INTERVAL_MS = 60_000
const ATTACH_POLL_MS = 50

export interface SafariBridgeHostProps {
  native: BsvBridgeNative
  getIdentityKey: () => Promise<string | null>
}

interface Running {
  dead: boolean
  writer: MirrorWriter | undefined
  cleanups: Array<() => void>
  /** Stops everything, in reverse order of creation. Idempotent. */
  stop(): void
}

interface Slot {
  native: BsvBridgeNative
  getIdentityKey: () => Promise<string | null>
  refs: number
  running: Running
  /** Cancels a pending restart-after-reset watch. */
  cancelRestart: (() => void) | undefined
  /** Formats satoshis in the user's display currency; the component keeps it current. */
  format: (sats: number) => string
  /** Receipt listeners (the component). */
  receiptListeners: Set<(receipt: Receipt) => void>
}

let slot: Slot | undefined

const warn = (what: string) => (e: unknown) => console.warn(`[safari-bridge] ${what} failed`, e)

function waitAttached(running: Running): Promise<void> {
  return new Promise(resolve => {
    if (running.dead || isBridgeHostAttached()) return resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsub: (() => void) | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      unsub?.()
      resolve()
    }
    const check = () => {
      if (running.dead || isBridgeHostAttached()) return done()
      timer = setTimeout(check, ATTACH_POLL_MS)
    }
    unsub = onSnapshotChange(() => {
      if (running.dead || isBridgeHostAttached()) done()
    })
    running.cleanups.push(done)
    timer = setTimeout(check, ATTACH_POLL_MS)
  })
}

function startRunning(s: Slot): Running {
  const running: Running = {
    dead: false,
    writer: undefined,
    cleanups: [],
    stop() {
      if (running.dead) return
      running.dead = true
      for (const c of running.cleanups.splice(0).reverse()) {
        try {
          c()
        } catch (e) {
          console.warn('[safari-bridge] cleanup failed', e)
        }
      }
    }
  }
  void run(s, running).catch(warn('startup'))
  return running
}

async function run(s: Slot, running: Running): Promise<void> {
  const { native } = s
  // 1. init, then the adapter.
  const { bootId, scheme } = await native.init({ nowMs: Date.now() })
  if (running.dead) return
  const store = createNativeInboxStore(native, { now: Date.now, bootId })

  // 2. Wait for the P1 host (readiness is not the signal).
  await waitAttached(running)
  if (running.dead) return

  const tracker = createReceiptTracker()
  const receiptDispatch = createReceiptDispatch(dispatch, tracker, {
    format: sats => s.format(sats),
    onReceipt: receipt => {
      for (const listener of [...s.receiptListeners]) listener(receipt)
    }
  })

  // 3. Register before the processor can handle anything. Never pass deliverReconnectToken.
  const handle: TransportHandle = registerTransport({
    id: SAFARI_TRANSPORT_ID,
    attestation: 'browser',
    bindingMode: 'implicit',
    // The handoff already put the app in front, so nothing is shown; the tracker marks the call as "needed the app".
    requestAttention: (reason, binding) => {
      if (reason === 'consent' || reason === 'wallet-not-ready') tracker.mark(binding.epoch)
    },
    onPromptRaised: binding => tracker.mark(binding.epoch)
  })
  running.cleanups.push(() => handle.unregister())

  // 4. The processor, then crash recovery.
  const processor: InboxProcessor = createInboxProcessor({
    store,
    dispatch: receiptDispatch,
    bindings: getBindingRegistry(),
    now: Date.now,
    transport: { id: SAFARI_TRANSPORT_ID, attestation: 'browser' }
  })
  running.cleanups.push(() => processor.dispose())
  await processor.recover()
  if (running.dead) return

  // 5. The mirror writer and the logout hook.
  const writer = createMirrorWriter({
    native,
    processor,
    getSnapshot: getBridgeSnapshot,
    onSnapshotChange,
    isBridgeHostAttached,
    listConnectedSites,
    onConsentChange: onConnectedSitesChange,
    getPermissionPolicy,
    getIdentityKey: () => s.getIdentityKey(),
    bootId,
    now: Date.now
  })
  running.writer = writer
  running.cleanups.push(() => writer.stop())
  writer.start()
  running.cleanups.push(registerSessionTeardown(['logout'], () => resetSafariBridge()))

  // The native store's sweeps (result purge, tombstones, stage chunks, events) are app-only and run on
  // each drain and on the timer, not only at init: the process may live for days (spec 6.4).
  const sweepStore = () => native.sweep({ nowMs: Date.now() }).catch(warn('sweep'))

  // Drain: sweep, then process without awaiting (a record parked behind a sheet stays open as long as the user takes).
  const drain = () => {
    if (running.dead) return
    void sweepStore()
    void processor
      .sweepExpired()
      .catch(warn('sweepExpired'))
      .then(() => {
        if (!running.dead) void processor.processPending().catch(warn('processPending'))
      })
  }

  // Triggers.
  const onUrl = (url: string | null | undefined) => {
    if (typeof url === 'string' && parseHandoffUrl(url, scheme)) drain()
  }
  const linking = Linking.addEventListener('url', e => onUrl(e?.url))
  running.cleanups.push(() => linking?.remove?.())

  let sweepTimer: ReturnType<typeof setInterval> | undefined
  const stopTimer = () => {
    if (sweepTimer !== undefined) clearInterval(sweepTimer)
    sweepTimer = undefined
  }
  const startTimer = () => {
    if (sweepTimer === undefined)
      sweepTimer = setInterval(() => {
        void sweepStore()
        void processor.sweepExpired().catch(warn('sweepExpired'))
      }, SWEEP_INTERVAL_MS)
  }
  const appState = AppState.addEventListener('change', state => {
    if (state === 'active') {
      startTimer()
      drain()
    } else stopTimer()
  })
  running.cleanups.push(() => appState?.remove?.(), stopTimer)
  if (AppState.currentState === 'active') startTimer()

  // The nudge is honoured only while the app is active.
  const unNudge = native.subscribeNudge(() => {
    if (AppState.currentState === 'active') drain()
  })
  running.cleanups.push(unNudge)

  // 6. First drain (a cold start into a scheme wake also drains, once attached).
  drain()
  void Linking.getInitialURL()
    .then(onUrl)
    .catch(() => undefined)
}

/**
 * The logout teardown (spec 6.4, 6.5): disables the mirror writer, then resets the native container,
 * both synchronously. The host calls nothing itself; `registerSessionTeardown` reaches this once per
 * logout (Delete Wallet included).
 */
export function resetSafariBridge(): void {
  const s = slot
  if (s === undefined || s.running.dead) return
  const { running, native } = s
  running.writer?.disable()
  try {
    native.reset()
  } catch (e) {
    console.warn('[safari-bridge] reset failed', e)
  }
  running.stop()
  armRestart(s)
}

/** After a reset, restart once a new wallet appears: the snapshot goes `none` (if it is not already), then leaves it. */
function armRestart(s: Slot): void {
  s.cancelRestart?.()
  let sawNone = getBridgeSnapshot().readiness === 'none'
  const unsub = onSnapshotChange(snap => {
    if (snap.readiness === 'none') {
      sawNone = true
      return
    }
    if (!sawNone || slot !== s) return
    unsub()
    s.cancelRestart = undefined
    s.running = startRunning(s)
  })
  s.cancelRestart = unsub
}

function acquire(native: BsvBridgeNative, getIdentityKey: () => Promise<string | null>): () => void {
  if (slot !== undefined && slot.native !== native) {
    slot.cancelRestart?.()
    slot.running.stop()
    slot = undefined
  }
  if (slot === undefined) {
    const s: Slot = {
      native,
      getIdentityKey,
      refs: 0,
      running: undefined as unknown as Running,
      cancelRestart: undefined,
      format: sats => `${sats} sats`,
      receiptListeners: new Set()
    }
    slot = s
    s.running = startRunning(s)
  }
  const s = slot
  s.refs++
  s.getIdentityKey = getIdentityKey
  let released = false
  return () => {
    if (released) return
    released = true
    s.refs--
    if (s.refs > 0) return
    s.cancelRestart?.()
    s.running.stop()
    if (slot === s) slot = undefined
  }
}

/** The display-currency formatter, exact (no abbreviation), from the same settings the permission sheet uses. */
function useFormatSats(): (sats: number) => string {
  const { settings } = useContext(WalletContext)
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'
  return useCallback(
    (sats: number) => formatAmount(sats, currency, satoshisPerUSD, { usdToFiat }),
    [currency, satoshisPerUSD, usdToFiat]
  )
}

export function SafariBridgeHost({ native, getIdentityKey }: SafariBridgeHostProps): React.ReactElement | null {
  const keyRef = useRef(getIdentityKey)
  keyRef.current = getIdentityKey
  const format = useFormatSats()
  const formatRef = useRef(format)
  formatRef.current = format
  const busy = usePermissionSheetBusy()
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [toast, setToast] = useState<{ ok: boolean; id: number } | null>(null)
  const [active, setActive] = useState(AppState.currentState === 'active')
  const toastId = useRef(0)

  useEffect(() => {
    const release = acquire(native, () => keyRef.current())
    const s = slot
    if (s === undefined) return release
    s.format = sats => formatRef.current(sats)
    const listener = (receipt: Receipt) => {
      // A receipt that lands while the app is away has nobody to read it.
      if (AppState.currentState !== 'active') return
      if (receipt.ok && receipt.neededApproval) setReceipts(prev => [...prev, receipt])
      else setToast({ ok: receipt.ok, id: ++toastId.current })
    }
    s.receiptListeners.add(listener)
    return () => {
      s.receiptListeners.delete(listener)
      release()
    }
  }, [native])

  // The done screen goes when the app leaves the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setActive(state === 'active')
      if (state !== 'active') {
        setReceipts([])
        setToast(null)
      }
    })
    return () => sub?.remove?.()
  }, [])

  const dismiss = useCallback(() => setReceipts([]), [])
  const hideToast = useCallback(() => setToast(null), [])
  const doneShown = active && !busy && receipts.length > 0
  return (
    <>
      <DoneScreen receipts={receipts} active={active} busy={busy} onDismiss={dismiss} />
      <Toast toast={doneShown ? null : toast} onHide={hideToast} />
    </>
  )
}
