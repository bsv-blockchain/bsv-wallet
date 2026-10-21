/**
 * `@bsv/webrtpay` as the toolbox uses it. It is an optional peer dependency: a host that offers
 * direct payments installs it (with react-native-webrtc), and every other host has none.
 *
 * So nothing in the toolbox imports it, not even for types. The package ships as TypeScript
 * source, and a type import of a module a host does not have fails that host's type check. The
 * shapes below are the slices the toolbox calls, written out by hand;
 * `__tests__/directpay/webrtpayShape.test.ts` checks at type level that the real package fits
 * them, so a release that changes one fails there rather than on a phone.
 *
 * The package is required lazily, inside a `try`, the way `services/vault/driver.ts` requires
 * react-native-yubikey: Metro skips a missing module there because Expo's Metro config turns on
 * `allowOptionalDependencies`, and requiring it only on first use keeps the barrel import free
 * of it. `loadWebRTPay()` is null when it is not installed (or will not load).
 */
import type { WalletInterface } from '@bsv/sdk'
import type { IceServer } from './settings'

/** The slice of a BRC-100 wallet `@bsv/webrtpay` uses (its `WalletLike`). */
export type WebRTPayWallet = Pick<
  WalletInterface,
  | 'getPublicKey'
  | 'createSignature'
  | 'verifySignature'
  | 'encrypt'
  | 'decrypt'
  | 'createHmac'
  | 'verifyHmac'
  | 'internalizeAction'
>

/** `WebRTPayError`: `code` says what failed; `reason` is a refusal's reason (`busy`, …). */
export interface WebRTPayErrorLike extends Error {
  readonly code: string
  readonly reason?: string
}

/** A payment token as it goes over the link (PeerPay's `PaymentToken`). */
export interface DirectPaymentToken {
  customInstructions: { derivationPrefix: string; derivationSuffix: string }
  transaction: number[]
  amount: number
  outputIndex?: number
}

/** A payment from an authenticated peer: `sender` is the peer's proven identity key. */
export interface IncomingDirectPayment {
  messageId: string
  sender: string
  token: DirectPaymentToken
  outputIndex?: number
}

/** What this wallet answers a payment with: in the wallet, kept for a retry, or refused. */
export type DirectPaymentDecision = 'accepted' | 'received' | { status: 'rejected'; reason: string }

/** The payee's answer to a payment. */
export interface DirectPaymentAck {
  status: 'accepted' | 'received' | 'rejected'
  txid?: string
  reason?: string
}

/** An authenticated link to one peer. */
export interface DirectPeer {
  readonly peerIdentityKey: string
  readonly isOpen: boolean
  close(): void
}

export interface DirectReceiveHandlers {
  onPayment(p: IncomingDirectPayment, ctx: { note?: string; txid: string }): Promise<DirectPaymentDecision>
  onError?(e: unknown): void
}

/** `DirectPayClient`: dials, sends, and receives while listening. */
export interface DirectPayClientLike {
  startReceiving(h: DirectReceiveHandlers): Promise<void>
  stopReceiving(): Promise<void>
  connect(recipient: string, o?: { signal?: AbortSignal }): Promise<DirectPeer>
  sendPayment(peer: DirectPeer, token: DirectPaymentToken, o?: { note?: string }): Promise<DirectPaymentAck>
  close(): Promise<void>
}

/** An encrypted signal as a carrier moves it; the toolbox never opens one. */
export interface SignalEnvelopeLike {
  v: 1
  sid: string
  ciphertext: string
}

/** A carrier for signals: the message box or a relay. */
export interface SignalerLike {
  send(to: string, e: SignalEnvelopeLike): Promise<void>
  listen(fn: (from: string, e: SignalEnvelopeLike) => void): Promise<() => Promise<void>>
}

/** `connecting` while it opens, `online` once the relay accepted this wallet, else `offline`. */
export type RelayState = 'connecting' | 'online' | 'offline'

export interface RelaySignalerLike extends SignalerLike {
  close(): Promise<void>
  /** The relay's short-lived TURN servers, for `iceServersProvider`. */
  turnProvider(): () => Promise<IceServer[]>
}

/**
 * The message box client as the signaler uses it. message-box-client's `PeerPayClient` is one
 * (pinned at type level in `__tests__/directpay/webrtpayShape.test.ts`); its live websocket
 * calls make the signaler fast enough for the dial's presence window.
 */
export interface MessageBoxLike {
  sendMessage(a: { recipient: string; messageBox: string; body: string }, overrideHost?: string): Promise<unknown>
  listMessages(a: {
    messageBox: string
    host?: string
    limit?: number
    pageSize?: number
    maxPages?: number
    acceptPayments?: boolean
  }): Promise<{ messageId: string; sender: string; body: string | Record<string, unknown> }[]>
  acknowledgeMessage(a: { messageIds: string[]; host?: string }): Promise<unknown>
  resolveHostForRecipient?(identityKey: string): Promise<string>
  sendLiveMessage?(a: { recipient: string; messageBox: string; body: string }, overrideHost?: string): Promise<unknown>
  listenForLiveMessages?(a: {
    messageBox: string
    overrideHost?: string
    onMessage: (m: { messageId: string; sender: string; body: string | Record<string, unknown> }) => void
  }): Promise<void>
  joinRoom?(messageBox: string, overrideHost?: string): Promise<void>
  leaveRoom?(messageBox: string): Promise<void>
}

export interface DirectPayClientOptions {
  wallet: WebRTPayWallet
  originator?: string
  signaler?: SignalerLike
  rtc?: {
    iceServers?: IceServer[]
    /**
     * The host's constructor (react-native-webrtc's on a phone). `any` because the package
     * wants the DOM's `typeof RTCPeerConnection`, and the toolbox has no WebRTC types.
     */
    RTCPeerConnection?: any
  }
  iceServersProvider?: () => Promise<IceServer[]>
  onIceServersProviderError?: (e: unknown) => void
  chain?: string
  timeouts?: { connectMs?: number; ackMs?: number; presenceMs?: number; dialMs?: number }
}

export interface RelaySignalerOptions {
  url: string
  wallet: Pick<WebRTPayWallet, 'getPublicKey' | 'createSignature'>
  originator?: string
  onStateChange?: (state: RelayState, error?: WebRTPayErrorLike) => void
}

/** A seen store: which payments were already taken (`paymentKey`). */
export interface DirectPaySeenStore {
  has(key: string): boolean | Promise<boolean>
  add(key: string): void | Promise<void>
}

/** The module, as far as the toolbox calls it. */
export interface WebRTPayModule {
  DirectPayClient: new (o: DirectPayClientOptions) => DirectPayClientLike
  MessageBoxSignaler: new (client: MessageBoxLike, o?: { messageBox?: string; host?: string }) => SignalerLike
  RelaySignaler: new (o: RelaySignalerOptions) => RelaySignalerLike
  WebRTPayError: new (
    code: 'rejected' | 'invalid_payment',
    message?: string,
    o?: { cause?: unknown; reason?: string }
  ) => WebRTPayErrorLike
  acceptDirectPayment(
    wallet: WebRTPayWallet,
    p: IncomingDirectPayment,
    o?: { originator?: string; seen?: DirectPaySeenStore; labels?: string[]; description?: string }
  ): Promise<{ txid: string; status: 'accepted' | 'duplicate' }>
  validatePaymentToken(token: DirectPaymentToken, note?: string): void
  readonly MAX_DIRECT_TRANSACTION_BYTES: number
}

let loaded: WebRTPayModule | null | undefined

/** `@bsv/webrtpay`, or null when this host does not have it. Required once, on first use. */
export function loadWebRTPay(): WebRTPayModule | null {
  if (loaded !== undefined) return loaded
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('@bsv/webrtpay') as WebRTPayModule
  } catch (e) {
    console.warn('[directpay] @bsv/webrtpay is not available:', e instanceof Error ? e.message : String(e))
    loaded = null
  }
  return loaded
}

/** Replaces what {@link loadWebRTPay} returns; `undefined` loads the package again. Tests only. */
export function setWebRTPayForTests(m: WebRTPayModule | null | undefined): void {
  loaded = m
}

/** Whether `e` is a `WebRTPayError` of `mod`, or one that lost its prototype on the way (duck-typed). */
export function isWebRTPayError(mod: Pick<WebRTPayModule, 'WebRTPayError'>, e: unknown): e is WebRTPayErrorLike {
  if (e instanceof mod.WebRTPayError) return true
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'WebRTPayError'
}
