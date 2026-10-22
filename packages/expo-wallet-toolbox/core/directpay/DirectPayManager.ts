/**
 * DirectPayManager owns the open wallet's direct (peer-to-peer) payment client. Ported from
 * BSV Desktop's `src/lib/services/DirectPayManager.ts`; what differs on a phone is listed last.
 *
 * `DirectPayProvider` starts it once a wallet is built and stops it when the wallet goes. While
 * a wallet is open there is always a client, so this wallet can dial others. Dialing and
 * receiving by identity key need a signaler, chosen in the device settings: a relay server (the
 * default) or the message box. Receiving is on when the user left it on, the app is in the
 * foreground and the Receive screen is showing ({@link DirectPayManager.openReceiveScreen}; the
 * user's decision, 2026-10-21): the rest of the time this wallet answers no dial, so nobody can
 * learn its address or that it is open, and payers use the message box. Opening and closing the
 * screen starts and stops receiving on the same client, so a payment being sent is not cut off.
 * Payments are taken into the wallet at once (`receive.ts`). Live sessions carry payments only
 * (no payment request handler is given), and an authenticated peer may send at most
 * MAX_LIVE_MESSAGE_BYTES (a 1 MB transaction). Through a relay,
 * receiving follows the relay connection, which reconnects by itself, and every connection may
 * use the short-lived TURN servers the relay hands out.
 *
 * While receiving through the relay, a relay that cannot be reached (it refuses or drops the
 * connection, or this wallet is not online on it within {@link RELAY_START_MS}) hands receiving
 * to the message box, when this wallet has one (`relayUnreachable` in the snapshot). The relay
 * is retried in the background and receiving moves back to it once it accepts this wallet. The
 * retry starts {@link RELAY_RETRY_FIRST_MS} after a fallback, doubling with each fallback in a
 * row up to {@link RELAY_RETRY_MAX_MS}, so a relay that accepts and then drops this wallet does
 * not cycle quickly; once the relay has stayed online for {@link RELAY_STABLE_MS} the wait
 * starts over (as it does on every start). A user who chose the message box stays on it.
 *
 * While a wallet is open, its kept payments (acknowledged, not yet in the wallet) are retried:
 * when it opens, then on a backing-off timer, whenever the network comes back, and when the
 * app returns to the foreground. One pass at a time; a pass stops between payments once
 * {@link RETRY_PASS_MS} have passed, and a wallet call that takes longer than
 * {@link RETRY_CALL_MS} ends it.
 *
 * On a phone, unlike the desktop:
 * - Receiving runs only in the foreground. `setForeground(false)` (the app went to the
 *   background) starts the client over without receiving, so this wallet stops answering at
 *   once rather than when the OS suspends its sockets; `setForeground(true)` starts it over
 *   receiving. Starting over closes the client, so a payment being sent at that moment stops
 *   (before it is made, or it is left for the message box; see `rails/direct.ts`). The
 *   provider counts only `background` as leaving: `inactive` is a Face ID prompt or the
 *   control centre, which a payment in progress must survive.
 * - Toasts go through the host's `onToast`, in the user's language; there are no window
 *   events (a payment's `internalizeAction` refreshes balances by itself).
 * - The desktop's wallet-busy guards (its HTTP bridge, network switches) have no equivalent:
 *   the provider stops the manager before the wallet it runs on is torn down, and a retry pass
 *   holds no lock between payments.
 * - Network changes come from `subscribeOnline` (NetInfo) rather than the window's `online`.
 *
 * React integration: `subscribe` / `getSnapshot` (see DirectPayProvider).
 */
import i18n from '../i18n/translations'
import type { KVStorage } from '../localpay/pending'
import { classifyCreditError, type CreditFailureKind } from '../pay/creditErrors'
import { iceServersFrom, MAX_LIVE_MESSAGE_BYTES, onlyOwnStun } from './settings'
import {
  receiveDirectPayment,
  retryKeptDirectPayments,
  RetryStopped,
  type DirectPayStore,
  type DirectReceipt,
  type KeptDirectPaymentInfo
} from './receive'
import type { DirectPaySettings, DirectPayStatus } from './types'
import type {
  DirectPayClientLike,
  IncomingDirectPayment,
  MessageBoxLike,
  RelaySignalerLike,
  RelayState,
  SignalerLike,
  WebRTPayErrorLike,
  WebRTPayModule,
  WebRTPayWallet
} from './webrtpay'

export interface DirectPaySnapshot {
  /** For sending; null while no wallet is open. */
  client: DirectPayClientLike | null
  status: DirectPayStatus
  /** How this wallet reaches others by identity key; null when it cannot. */
  via: 'messagebox' | 'relay' | null
  /** The settings choose the relay, but it cannot be reached, so `via` is the message box until it can. */
  relayUnreachable: boolean
  /** Why `status` is `error`, in English, for the log (the Receive card words it from `status`). */
  error: string
  /** Why direct payments by identity key are not set up, when that is not a failure (no message box). */
  notice: string
  /** Direct payments received since the wallet opened. */
  received: number
  /** The app is in the background, so this wallet is not receiving whatever the settings say. */
  background: boolean
}

export interface DirectPayStartOptions {
  wallet: WebRTPayWallet
  originator: string
  /** This wallet's identity key. */
  identity: string
  /** `main` or `test`: dials and answers are bound to it. */
  chain: string
  /** Carries signals when the settings choose the message box; null without a message box. */
  peerPayClient: MessageBoxLike | null
  /** The message box host to poll for signals (skips an overlay lookup per poll). */
  messageBoxUrl?: string
  settings: DirectPaySettings
  /** The host's `RTCPeerConnection` (react-native-webrtc's), from `ToolboxConfig.directPay`. */
  RTCPeerConnection?: unknown
}

/** The host's toast, as WalletContextProvider and VaultProvider take it. */
export type DirectPayToast = (message: string, opts?: { type?: 'info' | 'success' | 'error' }) => void

export interface DirectPayManagerDeps {
  webrtpay: WebRTPayModule
  /** The device store for the seen store and kept payments (`deviceKVStorage`). */
  storage: KVStorage
  /**
   * How a failure to take a payment is classified. Built per payment and per retry pass, as
   * `makeCreditClassifier` builds it for the inbox; `classifyCreditError` without context when
   * omitted.
   */
  classifier?: () => Promise<(e: unknown) => CreditFailureKind>
  onToast?: DirectPayToast
  /** A payment arrived (once per payment): in the wallet (`accepted`) or kept on this device. */
  onReceived?: (p: { amount: number; sender: string; status: DirectReceipt['status'] }) => void
  /** NetInfo's online signal (`core/net/online.ts`); kept payments are retried when it comes back. */
  subscribeOnline?: (cb: (online: boolean) => void) => () => void
  getOnline?: () => Promise<boolean>
  /** Whether the app starts in the foreground. Default true. */
  foreground?: boolean
}

const OFF: DirectPaySnapshot = {
  client: null,
  status: 'off',
  via: null,
  relayUnreachable: false,
  error: '',
  notice: '',
  received: 0,
  background: false
}

/** How long receiving through the relay may take to come online before it falls back to the message box. */
export const RELAY_START_MS = 5000
/** How long a dial may take to open the link once the recipient has answered (package default 6 s). */
export const DIAL_MS = 10_000
/** The wait before the relay is retried after a fallback; doubles per fallback in a row. */
export const RELAY_RETRY_FIRST_MS = 5000
export const RELAY_RETRY_MAX_MS = 5 * 60_000
/** How long the relay must stay online before the retry wait starts over. */
export const RELAY_STABLE_MS = 60_000

/** Kept payments are retried when a wallet opens, then after 60 s, doubling to every 15 minutes. */
export const RETRY_FIRST_MS = 60_000
export const RETRY_MAX_MS = 15 * 60_000
/** A retry pass starts no payment after this long. */
export const RETRY_PASS_MS = 15_000
/** A retry's wallet call that takes longer ends the pass. */
export const RETRY_CALL_MS = 15_000

/** Failed polls of the message box in a row before the status says it cannot be reached. */
const POLL_FAILURES_SHOWN = 2

const NO_RELAY = 'No relay server is set; enter one in Settings, or use the message box for direct payments.'
const NO_MESSAGE_BOX =
  'Direct payments reach other wallets through the message box. Connect a message box in Settings, or use a relay server.'

type Started = {
  options: DirectPayStartOptions
  /** The client's signaler when it is a relay, or the relay being retried while on the message box. */
  relay: RelaySignalerLike | null
  /** Runs on teardown. */
  unsubscribe: () => void
}

/** Which way a launch signals: as the settings say, or (`fallback`) through the message box while the relay is retried. */
type Carrier = 'settings' | 'fallback'

type RetrySchedule = {
  options: DirectPayStartOptions
  /** The wait before the next timed pass; doubles after each, up to {@link RETRY_MAX_MS}. */
  delay: number
  timer?: ReturnType<typeof setTimeout>
  /** When `timer` fires (ms since the epoch). */
  due?: number
  /** The next pass also offers payments that need attention (the wallet opened, or the network came back). */
  withAttention: boolean
  running: boolean
  /** Asked for while a pass was running: run another as soon as it ends. */
  again: boolean
  unsubscribeOnline: () => void
}

export class DirectPayManager {
  private _snapshot: DirectPaySnapshot = OFF
  private readonly _listeners = new Set<(s: DirectPaySnapshot) => void>()
  private _started: Started | null = null
  /** Settles when the current start has finished setting up receiving. */
  private _starting: Promise<void> = Promise.resolve()
  /** Bumped by every start and stop; a start that is no longer current changes nothing. */
  private _generation = 0
  private _retry: RetrySchedule | null = null
  /** Fallbacks to the message box in a row: sets the wait before the relay is retried. */
  private _fallbacks = 0
  /** Resets {@link _fallbacks} once the relay has stayed online; cleared by every teardown. */
  private _stableTimer: ReturnType<typeof setTimeout> | undefined
  private _foreground: boolean
  /** The last relay connection failed and has not come online since (see {@link signalingDown}). */
  private _relayDown = false
  /** Receive screens showing now (see {@link openReceiveScreen}). */
  private _receiveScreens = 0
  /** The current client answers dials: set by {@link _beginReceiving}, cleared by {@link _endReceiving} and teardown. */
  private _receiving = false
  /** Bumped whenever receiving starts or ends; a start that is no longer current changes nothing. */
  private _receiveRun = 0
  /** Undone when receiving ends: the relay start timer, the relay retry. */
  private _receiveCleanups: Array<() => void> = []

  private readonly _deps: DirectPayManagerDeps

  constructor(deps: DirectPayManagerDeps) {
    this._deps = { ...deps }
    this._foreground = deps.foreground ?? true
  }

  /** Replaces the toast, the arrival callback or the classifier (a React host passes its latest). */
  setCallbacks(callbacks: Pick<DirectPayManagerDeps, 'onToast' | 'onReceived' | 'classifier'>): void {
    Object.assign(this._deps, callbacks)
  }

  getSnapshot = (): DirectPaySnapshot => this._snapshot

  /** Calls `fn` with every new snapshot; returns the unsubscribe. */
  subscribe = (fn: (s: DirectPaySnapshot) => void): (() => void) => {
    this._listeners.add(fn)
    return () => {
      this._listeners.delete(fn)
    }
  }

  /**
   * Starts direct payments for a wallet. Called again with the same inputs it does nothing,
   * unless receiving failed (the relay is unreachable): then it starts over at once. With
   * different inputs it replaces the client. Never rejects: problems show as `status: 'error'`.
   */
  start(o: DirectPayStartOptions): Promise<void> {
    const previous = this._started?.options
    if (previous && sameInputs(previous, o) && !receiveFailed(this._snapshot)) return this._starting
    const sameWallet = previous !== undefined && isSameWallet(previous, o)
    const received = sameWallet ? this._snapshot.received : 0
    const closing = this._teardown()
    this._fallbacks = 0
    this._starting = this._launch(o, received, closing, 'settings')
    if (!sameWallet) this._startRetries(o)
    return this._starting
  }

  /** Uses new settings for the open wallet (no-op when nothing changed or none is open). */
  async applySettings(s: DirectPaySettings): Promise<void> {
    if (!this._started) return
    await this.start({ ...this._started.options, settings: s })
  }

  /**
   * The app moved to (`true`) or from (`false`) the foreground. Receiving follows: the client
   * starts over with receiving on or off (see the header). Kept-payment retries pause in the
   * background and run once on return.
   */
  setForeground(foreground: boolean): void {
    if (foreground === this._foreground) return
    this._foreground = foreground
    const started = this._started
    if (started) {
      const received = this._snapshot.received
      const closing = this._teardown()
      this._fallbacks = 0
      this._starting = this._launch(started.options, received, closing, 'settings')
    }
    const s = this._retry
    if (!s) return
    if (foreground) {
      this._retryNow(s, false)
    } else {
      clearTimeout(s.timer)
      s.timer = undefined
      s.due = undefined
    }
  }

  /**
   * Whether this wallet's own way of reaching others is down: the device is offline, or the
   * relay's last connection failed and has not come back. A dial nobody answered then says
   * nothing about the recipient (`rails/direct.ts` reports it as `unavailable`).
   */
  signalingDown = async (): Promise<boolean> => {
    if (this._relayDown && this._snapshot.via === 'relay') return true
    try {
      return this._deps.getOnline ? !(await this._deps.getOnline()) : false
    } catch {
      return false
    }
  }

  /**
   * The Receive screen is showing: while at least one is, receiving is on (when the settings
   * turn it on and the app is in the foreground). Returns the function to call when it stops
   * showing; calling it again does nothing. Works with no wallet open: receiving then starts
   * with the wallet.
   */
  openReceiveScreen = (): (() => void) => {
    this._receiveScreens++
    if (this._receiveScreens === 1) this._receiveScreenChanged()
    let open = true
    return () => {
      if (!open) return
      open = false
      this._receiveScreens--
      if (this._receiveScreens === 0) this._receiveScreenChanged()
    }
  }

  /** Closes the client and signaler. The snapshot clears at once; never rejects. */
  async stop(): Promise<void> {
    this._stopRetries()
    const closing = this._teardown()
    if (this._snapshot !== OFF) this._set(OFF)
    await closing
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Sets up a client synchronously (so the snapshot has it at once), then receiving. */
  private async _launch(
    o: DirectPayStartOptions,
    received: number,
    closing: Promise<void>,
    carrier: Carrier
  ): Promise<void> {
    const { webrtpay } = this._deps
    const generation = this._generation
    let client: DirectPayClientLike | null = null
    let relay: RelaySignalerLike | null = null
    let signaler: SignalerLike | undefined
    let via: DirectPaySnapshot['via'] = null
    let error = ''
    let notice = ''
    const fallback = carrier === 'fallback'
    try {
      if (o.settings.signaling === 'relay' && !fallback) {
        if (!o.settings.relayUrl) {
          error = NO_RELAY
        } else {
          const url = o.settings.relayUrl
          relay = new webrtpay.RelaySignaler({
            url,
            wallet: o.wallet,
            originator: o.originator,
            onStateChange: (state, e) => this._relayChanged(generation, o, url, state, e)
          })
          signaler = relay
          via = 'relay'
        }
      } else if (!o.peerPayClient) {
        notice = NO_MESSAGE_BOX
      } else {
        let failures = 0
        const polled = (pollError?: unknown) => {
          failures = pollError === undefined ? 0 : failures + 1
          this._messageBoxPolled(generation, failures, pollError)
        }
        signaler = new webrtpay.MessageBoxSignaler(watchingPolls(o.peerPayClient, polled), {
          host: o.messageBoxUrl || undefined,
          messageBox: signalBox(o.chain)
        })
        via = 'messagebox'
      }
      client = new webrtpay.DirectPayClient({
        wallet: o.wallet,
        originator: o.originator,
        chain: o.chain,
        signaler,
        rtc: {
          iceServers: iceServersFrom(o.settings),
          ...(o.RTCPeerConnection !== undefined && { RTCPeerConnection: o.RTCPeerConnection })
        },
        // Live sessions carry a payment and its ack: an authenticated peer may send this wallet
        // no more than a payment with a 1 MB transaction (larger ones go by message box).
        maxMessageBytes: MAX_LIVE_MESSAGE_BYTES,
        limits: { maxMessageBytes: MAX_LIVE_MESSAGE_BYTES },
        // Once the recipient has answered, give the link 10 s (the package default is 6 s): a
        // slow STUN or TURN answer on a phone network otherwise ends a payment the recipient is
        // online for.
        timeouts: { dialMs: DIAL_MS },
        // The relay's TURN servers, asked for before each ICE gather. One provider for the
        // client's life: it reuses live credentials.
        ...(relay &&
          !fallback && {
            iceServersProvider: ownStunOnly(relay.turnProvider()),
            onIceServersProviderError: (e: unknown) =>
              console.warn("[DirectPayManager] Connecting without the relay's TURN servers:", messageOf(e))
          })
      })
    } catch (e) {
      void relay?.close().catch(() => {})
      relay = null
      via = null
      notice = ''
      error = `Direct payments could not be set up: ${messageOf(e)}`
    }

    const receive = !error && !notice && this._receives(o)
    this._started = { options: o, relay, unsubscribe: () => {} }
    this._set({
      client,
      status: error ? 'error' : receive ? 'starting' : 'off',
      via,
      relayUnreachable: fallback,
      error,
      notice,
      received,
      background: !this._foreground
    })
    if (!receive || !client) return
    await this._beginReceiving(generation, o, client, relay, fallback, closing)
  }

  /** Receiving is on: the user's switch, the app in the foreground, and a Receive screen showing. */
  private _receives(o: DirectPayStartOptions): boolean {
    return o.settings.receiveEnabled && this._foreground && this._receiveScreens > 0
  }

  /**
   * A Receive screen opened or the last one closed: starts or stops receiving on the current
   * client, without replacing it (a payment being sent keeps its connection).
   */
  private _receiveScreenChanged(): void {
    const started = this._started
    const client = this._snapshot.client
    if (!started || !client) return
    const want = this._receives(started.options)
    if (want === this._receiving) return
    if (!want) {
      this._endReceiving()
      return
    }
    // A setup problem (no relay address, no message box) leaves nothing to receive through.
    if (this._snapshot.via === null || this._snapshot.notice) return
    const fallback = this._snapshot.relayUnreachable
    this._update({ status: 'starting', error: '' })
    // On the message box after a fallback, `started.relay` is only the relay being retried.
    void this._beginReceiving(
      this._generation,
      started.options,
      client,
      fallback ? null : started.relay,
      fallback,
      Promise.resolve()
    )
  }

  /**
   * Starts receiving on `client`: with the relay, the fallback to the message box when it is not
   * online in time; on that fallback, the relay retry; then the client listens.
   */
  private async _beginReceiving(
    generation: number,
    o: DirectPayStartOptions,
    client: DirectPayClientLike,
    relay: RelaySignalerLike | null,
    fallback: boolean,
    closing: Promise<void>
  ): Promise<void> {
    this._receiving = true
    const run = ++this._receiveRun
    if (relay && !fallback && o.peerPayClient) {
      // Not online through the relay in time: receive through the message box meanwhile.
      const timer = setTimeout(() => {
        if (generation === this._generation && run === this._receiveRun && this._snapshot.status !== 'online') {
          this._fallBack(generation, o, 'it did not accept this wallet in time')
        }
      }, RELAY_START_MS)
      this._receiveCleanups.push(() => clearTimeout(timer))
    }
    if (fallback) this._retryRelayLater(generation, o)

    // The previous client stops listening first, so two never answer the same offer.
    await closing
    if (generation !== this._generation || run !== this._receiveRun) return
    try {
      // onPayment only: payment requests sent over a live session are dropped unanswered.
      await client.startReceiving({
        onPayment: (p, ctx) => this._onPayment(o, p, ctx.note),
        onError: e => console.warn('[DirectPayManager] Inbound direct payment session failed:', messageOf(e))
      })
      // The status follows the relay's connection (_relayChanged) or the message box's polls
      // (_messageBoxPolled), so it says online only once receiving works. A stop asked for
      // meanwhile has already called stopReceiving, which runs after this start.
    } catch (e) {
      if (generation === this._generation && run === this._receiveRun) {
        this._update({ status: 'error', error: `Direct payments cannot be received: ${messageOf(e)}` })
      }
    }
  }

  /**
   * The last Receive screen closed: the client stops answering dials (sessions already open run
   * to their end), the relay retry stops, and the status is `off`. The client stays, for sending.
   */
  private _endReceiving(): void {
    if (!this._receiving) return
    this._receiving = false
    this._receiveRun++
    this._runReceiveCleanups()
    clearTimeout(this._stableTimer)
    this._stableTimer = undefined
    const client = this._snapshot.client
    if (client) {
      void client.stopReceiving().catch(e => console.warn('[DirectPayManager] Could not stop receiving:', messageOf(e)))
    }
    this._update({ status: 'off', error: '' })
  }

  private _runReceiveCleanups(): void {
    const cleanups = this._receiveCleanups
    this._receiveCleanups = []
    for (const fn of cleanups) {
      try {
        fn()
      } catch (e) {
        console.warn('[DirectPayManager] Cleanup failed:', messageOf(e))
      }
    }
  }

  /** Receiving through the relay failed: receive through the message box, retrying the relay. */
  private _fallBack(generation: number, o: DirectPayStartOptions, why: string): void {
    if (generation !== this._generation) return
    this._fallbacks++
    console.warn(`[DirectPayManager] Receiving through the message box: the relay cannot be reached (${why}).`)
    const received = this._snapshot.received
    const closing = this._teardown()
    this._starting = this._launch(o, received, closing, 'fallback')
  }

  /**
   * After the wait for this many fallbacks in a row, retries the relay while receiving through
   * the message box: listening keeps it trying, with the relay signaler's own backoff, until it
   * accepts this wallet. Teardown cancels the wait or closes the retry.
   */
  private _retryRelayLater(generation: number, o: DirectPayStartOptions): void {
    const wait = Math.min(RELAY_RETRY_FIRST_MS * 2 ** Math.max(0, this._fallbacks - 1), RELAY_RETRY_MAX_MS)
    let retry: RelaySignalerLike | null = null
    const timer = setTimeout(() => {
      const started = this._started
      if (generation !== this._generation || !started) return
      retry = new this._deps.webrtpay.RelaySignaler({
        url: o.settings.relayUrl,
        wallet: o.wallet,
        originator: o.originator,
        onStateChange: (state, e) => this._relayRetried(generation, o, state, e)
      })
      started.relay = retry
      retry
        .listen(() => {
          // Signals that reach the retry before receiving moves back to the relay: payers dial again.
        })
        .catch(() => {
          /* closed */
        })
    }, wait)
    // Receiving ended: the retry's relay connection (which makes this wallet look online) closes.
    this._receiveCleanups.push(() => {
      clearTimeout(timer)
      const started = this._started
      if (!retry) return
      if (started?.relay === retry) started.relay = null
      void retry.close().catch(() => {})
    })
  }

  /** The relay being retried accepted this wallet: receiving moves back to it. */
  private _relayRetried(generation: number, o: DirectPayStartOptions, state: RelayState, e?: WebRTPayErrorLike): void {
    if (generation !== this._generation) return
    if (state === 'offline' && e)
      console.warn('[DirectPayManager] The relay still cannot be reached:', e.code, e.message)
    if (state !== 'online') return
    const received = this._snapshot.received
    const closing = this._teardown()
    this._starting = this._launch(o, received, closing, 'settings')
  }

  /**
   * While receiving through a relay, the status follows its connection: `starting` while it
   * connects, `online` once the relay accepted this wallet, and `error` while it is offline
   * (the signaler keeps trying). With a message box, a relay gone offline hands receiving to it.
   * While not receiving, the relay connects only for payments, and the status stays `off`.
   */
  private _relayChanged(
    generation: number,
    o: DirectPayStartOptions,
    url: string,
    state: RelayState,
    e?: WebRTPayErrorLike
  ): void {
    if (generation !== this._generation) return
    if (state === 'online') this._relayDown = false
    else if (state === 'offline' && e) this._relayDown = true
    if (!this._receiving) return
    // Online long enough: the next fallback retries the relay after the shortest wait again.
    if (state === 'online' && this._stableTimer === undefined) {
      this._stableTimer = setTimeout(() => {
        this._stableTimer = undefined
        if (generation === this._generation) this._fallbacks = 0
      }, RELAY_STABLE_MS)
    } else if (state !== 'online') {
      clearTimeout(this._stableTimer)
      this._stableTimer = undefined
    }
    if (state === 'online') this._update({ status: 'online', error: '' })
    else if (state === 'offline' && e && o.peerPayClient) this._fallBack(generation, o, `${e.code}: ${e.message}`)
    else if (state === 'offline' && e) {
      this._update({ status: 'error', error: `Direct payments cannot be received: ${relayProblem(e, url)}` })
    }
    // Connecting again: keep showing why the last try failed until one succeeds.
    else if (this._snapshot.status !== 'error') this._update({ status: 'starting', error: '' })
  }

  /**
   * While receiving through the message box, the status follows its polls: `online` once a poll
   * worked, and `error` after {@link POLL_FAILURES_SHOWN} failures in a row (the signaler keeps
   * polling, and the status recovers by itself).
   */
  private _messageBoxPolled(generation: number, failures: number, error: unknown): void {
    if (generation !== this._generation || !this._receiving) return
    if (failures === 0) this._update({ status: 'online', error: '' })
    else if (failures >= POLL_FAILURES_SHOWN) {
      this._update({
        status: 'error',
        error: `Direct payments cannot be received: the message box cannot be reached (${messageOf(error)}). Trying again…`
      })
    }
  }

  /** Takes a payment into the wallet; a throw becomes a `rejected` ack for the payer. */
  private async _onPayment(
    o: DirectPayStartOptions,
    p: IncomingDirectPayment,
    note: string | undefined
  ): Promise<'accepted' | 'received'> {
    const classify = await this._classifier()
    const receipt = await receiveDirectPayment({
      webrtpay: this._deps.webrtpay,
      wallet: o.wallet,
      originator: o.originator,
      store: this._store(o),
      payment: p,
      note,
      classify
    })
    // The payment is taken: nothing below may turn the ack into a rejection.
    try {
      if (receipt.status === 'received' && !receipt.repeat) this._retrySoon(o)
      // Delivered again after a lost ack, or credited from the inbox first: announced already.
      if (!receipt.repeat) {
        const current = this._started?.options
        if (current && isSameWallet(current, o)) this._set({ ...this._snapshot, received: this._snapshot.received + 1 })
        this._deps.onToast?.(i18n.t('payment_arrived'), { type: 'success' })
        this._deps.onReceived?.({ amount: p.token.amount, sender: p.sender, status: receipt.status })
      }
    } catch (e) {
      console.warn('[DirectPayManager] Could not announce a received direct payment:', messageOf(e))
    }
    return receipt.status
  }

  private _store(o: DirectPayStartOptions): DirectPayStore {
    return { storage: this._deps.storage, identity: o.identity, chain: o.chain }
  }

  private async _classifier(): Promise<(e: unknown) => CreditFailureKind> {
    try {
      if (this._deps.classifier) return await this._deps.classifier()
    } catch {
      // Without its context, the plain classifier is still right for most failures.
    }
    return e => classifyCreditError(e)
  }

  /** Retries the kept payments of a wallet that just opened, now and while it stays open. */
  private _startRetries(o: DirectPayStartOptions): void {
    this._stopRetries()
    const s: RetrySchedule = {
      options: o,
      delay: RETRY_FIRST_MS,
      withAttention: true,
      running: false,
      again: false,
      unsubscribeOnline: () => {}
    }
    this._retry = s
    try {
      s.unsubscribeOnline =
        this._deps.subscribeOnline?.(online => {
          if (!online) return
          s.delay = RETRY_FIRST_MS
          this._retryNow(s, true)
        }) ?? (() => {})
    } catch (e) {
      console.warn('[DirectPayManager] Could not follow the network state:', messageOf(e))
    }
    this._retryNow(s, true)
  }

  /** The wallet closed: no more passes (one already running ends at its next payment). */
  private _stopRetries(): void {
    const s = this._retry
    if (!s) return
    this._retry = null
    clearTimeout(s.timer)
    try {
      s.unsubscribeOnline()
    } catch {
      // Nothing to undo.
    }
  }

  /** A payment was just kept: the next pass comes after the first wait at the latest. */
  private _retrySoon(o: DirectPayStartOptions): void {
    const s = this._retry
    if (!s || !isSameWallet(s.options, o)) return
    s.delay = RETRY_FIRST_MS
    if (s.running || !this._foreground) return // the pass, or the return to the foreground, schedules the next
    if (s.due !== undefined && s.due <= Date.now() + RETRY_FIRST_MS) return
    this._retryIn(s, RETRY_FIRST_MS)
  }

  /** Runs the next pass `ms` from now, replacing any pass already waiting. */
  private _retryIn(s: RetrySchedule, ms: number): void {
    clearTimeout(s.timer)
    s.due = Date.now() + ms
    s.timer = setTimeout(() => this._retryNow(s, false), ms)
  }

  /** Runs a pass now: never two at once (then once the running one ends), and not in the background. */
  private _retryNow(s: RetrySchedule, withAttention: boolean): void {
    if (this._retry !== s) return
    clearTimeout(s.timer)
    s.timer = undefined
    s.due = undefined
    s.withAttention ||= withAttention
    if (s.running) {
      s.again = true
      return
    }
    // In the background: the return to the foreground runs the pass.
    if (!this._foreground) return
    const withAttentionNow = s.withAttention
    s.withAttention = false
    s.running = true
    void this._runRetry(s, withAttentionNow).then(() => {
      s.running = false
      if (this._retry !== s) return
      if (s.again) {
        s.again = false
        this._retryNow(s, false)
        return
      }
      if (!this._foreground) return
      this._retryIn(s, s.delay)
      s.delay = Math.min(s.delay * 2, RETRY_MAX_MS)
    })
  }

  /** One pass over the wallet's kept payments (see the header). Never rejects. */
  private async _runRetry(s: RetrySchedule, includeNeedsAttention: boolean): Promise<void> {
    const o = s.options
    const deadline = Date.now() + RETRY_PASS_MS
    const run = async <T>(call: () => Promise<T>): Promise<T> => {
      if (this._retry !== s) throw new RetryStopped('The wallet closed')
      if (Date.now() >= deadline) throw new RetryStopped('The pass took its time')
      return await withDeadline(call(), RETRY_CALL_MS)
    }
    try {
      await retryKeptDirectPayments({
        webrtpay: this._deps.webrtpay,
        wallet: o.wallet,
        originator: o.originator,
        store: this._store(o),
        classify: await this._classifier(),
        includeNeedsAttention,
        onNeedsAttention: kept => this._reportNeedsAttention(kept),
        run
      })
    } catch (e) {
      console.warn('[DirectPayManager] Retrying kept direct payments failed:', messageOf(e))
    }
  }

  /** The payer will not send a kept payment again; it stays kept, and the user is told. */
  private _reportNeedsAttention(p: KeptDirectPaymentInfo): void {
    this._deps.onToast?.(
      i18n.t('direct_pay_kept_needs_attention', {
        amount: p.amount.toLocaleString(),
        name: `${p.sender.slice(0, 8)}…`
      }),
      { type: 'error' }
    )
  }

  /** Detaches the current client and signaler; returns their closing (never rejects). */
  private _teardown(): Promise<void> {
    this._generation++
    this._receiving = false
    this._receiveRun++
    this._runReceiveCleanups()
    clearTimeout(this._stableTimer)
    this._stableTimer = undefined
    this._relayDown = false
    const started = this._started
    const client = this._snapshot.client
    this._started = null
    this._starting = Promise.resolve()
    if (!started) return Promise.resolve()
    started.unsubscribe()
    // Close the relay too, so a listen still connecting cannot hold the client's close.
    return Promise.allSettled([client?.close(), started.relay?.close()]).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') console.warn('[DirectPayManager] Close failed:', messageOf(r.reason))
      }
    })
  }

  private _set(snapshot: DirectPaySnapshot) {
    this._snapshot = snapshot
    for (const fn of [...this._listeners]) {
      try {
        fn(snapshot)
      } catch (e) {
        console.warn('[DirectPayManager] A listener failed:', messageOf(e))
      }
    }
  }

  /** Changes the status and its message; emits only when they change. */
  private _update(change: Pick<DirectPaySnapshot, 'status' | 'error'>) {
    if (change.status !== this._snapshot.status || change.error !== this._snapshot.error) {
      this._set({ ...this._snapshot, ...change })
    }
  }
}

/**
 * The message box that carries this network's signals. An identity key is the same on every
 * network, so one identity open on two networks would otherwise take the other network's dials.
 * Mainnet keeps the package's default box, where other wallets (BSV Desktop) dial.
 */
export const signalBox = (chain: string) => (chain === 'main' ? 'webrtpay_signals' : `webrtpay_signals_${chain}`)

/** The relay's TURN servers without the STUN servers its answer names (see onlyOwnStun). */
function ownStunOnly<T extends { urls: string | string[] }>(provider: () => Promise<T[]>): () => Promise<T[]> {
  return async () => onlyOwnStun(await provider())
}

/**
 * The message box client as the signaler sees it: the same calls, with each listing (a poll)
 * reported to `polled`, with its error when it failed. The live websocket calls and the host
 * lookup are passed on, bound to the client, when it has them: without them the signaler only
 * polls, which is too slow for a dial's presence window.
 */
function watchingPolls(client: MessageBoxLike, polled: (error?: unknown) => void): MessageBoxLike {
  // The status is only shown: reporting it must never fail a poll (its messages would be lost).
  const report = (error?: unknown) => {
    try {
      polled(error)
    } catch (e) {
      console.warn('[DirectPayManager] Could not show the message box status:', messageOf(e))
    }
  }
  return {
    sendMessage: (a, host) => client.sendMessage(a, host),
    listMessages: async a => {
      let messages: Awaited<ReturnType<MessageBoxLike['listMessages']>>
      try {
        messages = await client.listMessages(a)
      } catch (e) {
        report(e ?? new Error('The message box could not be listed'))
        throw e
      }
      report()
      return messages
    },
    acknowledgeMessage: a => client.acknowledgeMessage(a),
    ...(typeof client.sendLiveMessage === 'function' && {
      sendLiveMessage: (a: Parameters<NonNullable<MessageBoxLike['sendLiveMessage']>>[0], host?: string) =>
        client.sendLiveMessage!(a, host)
    }),
    ...(typeof client.listenForLiveMessages === 'function' && {
      listenForLiveMessages: (a: Parameters<NonNullable<MessageBoxLike['listenForLiveMessages']>>[0]) =>
        client.listenForLiveMessages!(a)
    }),
    ...(typeof client.joinRoom === 'function' && {
      joinRoom: (box: string, host?: string) => client.joinRoom!(box, host)
    }),
    ...(typeof client.leaveRoom === 'function' && { leaveRoom: (box: string) => client.leaveRoom!(box) }),
    ...(typeof client.resolveHostForRecipient === 'function' && {
      resolveHostForRecipient: (recipient: string) => client.resolveHostForRecipient!(recipient)
    })
  }
}

/** `p`, or a {@link RetryStopped} after `ms` (the call goes on, unobserved). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RetryStopped('The wallet took too long')), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

function isSameWallet(a: DirectPayStartOptions, b: DirectPayStartOptions): boolean {
  return a.wallet === b.wallet && a.identity === b.identity && a.chain === b.chain
}

/** Receiving was set up and failed (the relay is offline); a setup problem leaves `via` null instead. */
function receiveFailed(s: DirectPaySnapshot): boolean {
  return s.status === 'error' && s.via !== null
}

function sameInputs(a: DirectPayStartOptions, b: DirectPayStartOptions): boolean {
  return (
    isSameWallet(a, b) &&
    a.originator === b.originator &&
    a.peerPayClient === b.peerPayClient &&
    (a.messageBoxUrl || '') === (b.messageBoxUrl || '') &&
    a.RTCPeerConnection === b.RTCPeerConnection &&
    JSON.stringify(a.settings) === JSON.stringify(b.settings)
  )
}

/** Why the relay connection is down, for the log. */
function relayProblem(e: WebRTPayErrorLike, url: string): string {
  switch (e.code) {
    case 'auth_failed': {
      // The signaler gives a cause only when this wallet could not sign the relay's challenge.
      const { cause } = e as WebRTPayErrorLike & { cause?: unknown }
      if (cause !== undefined) {
        return `this wallet could not sign in to the relay server (${messageOf(cause).replace(/\.$/, '')}). Trying again…`
      }
      return `the relay server did not accept this wallet at ${url}; the address must be exactly one the relay serves. Trying again…`
    }
    case 'rate_limited':
      return 'the relay server is limiting connections from this network. Trying again…'
    case 'peer_unreachable':
      return 'the relay server cannot be reached. Trying again…'
    default:
      return `${e.message}. Trying again…`
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
