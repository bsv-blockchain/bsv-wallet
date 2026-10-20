/**
 * Shapes shared by the direct-pay (push payment) core: the device settings, why a dial
 * failed, how paying a wallet identity ended, and what the Receive card shows.
 *
 * Direct payments are a live link between two wallets (WebRTC), tried before the message box.
 * Nothing in this folder imports `@bsv/webrtpay` or a native module; the pieces that do arrive
 * in later changes and are handed to these functions as plain dependencies.
 */
import type { TranslationKey } from '../i18n/translations'

/** A TURN server, for testing; it may relay the encrypted link when two wallets cannot connect directly. */
export interface DirectPayTurn {
  urls: string
  username: string
  credential: string
}

/**
 * Settings for direct payments, one set per device (not per wallet or profile) so they are
 * readable before sign-in and survive logout.
 *
 * Receiving is on by default. While it is on, any wallet that knows the identity key can learn
 * this device's public IP address and when the wallet is open, by starting a connection without
 * paying. On mobile receiving only runs while the app is in the foreground; the switch here is
 * the user's choice, and the manager that listens enforces the foreground rule.
 * Sending directly needs no setting, and reveals the payer's IP address to the recipient's wallet.
 */
export interface DirectPaySettings {
  /** Answer direct payments from other wallets. On unless the user turns it off. */
  receiveEnabled: boolean
  /** How the two wallets find each other before connecting. */
  signaling: 'relay' | 'messagebox'
  /** wss:// signaling relay. Used when `signaling` is 'relay'. */
  relayUrl: string
  /** stun: / stuns: servers used to discover this device's public address. */
  stunUrls: string[]
  /** Optional TURN server. */
  turn?: DirectPayTurn
}

/**
 * Why dialing a recipient failed, for choosing what to offer the user (see `payIdentity`):
 *
 * - `offline`: no reply within the presence window, or the signaling relay could not be
 *   reached at all (the package raises `peer_unreachable` for both).
 * - `rejected`: their wallet answered and is not taking direct payments, or is busy.
 * - `unavailable`: the signaling service answered but could not do its part (the relay could
 *   not issue TURN credentials, or MessageBox could not deliver the signal).
 * - `timeout`: they answered, but the link or its identity handshake did not come up in time.
 * - `wrong_network`: the two wallets are on different networks.
 * - `aborted`: the dial was cancelled.
 * - `unknown`: anything else (a refusal with some other reason, a closed link, a bad handshake).
 */
export type DialFailure = 'offline' | 'rejected' | 'unavailable' | 'timeout' | 'wrong_network' | 'aborted' | 'unknown'

/** Some wording for the user, as an i18n key and its parameters (core modules never return English). */
export interface DirectPayMessage {
  key: TranslationKey
  params?: { name: string }
}

/** Why a live attempt is offering the message box: the recipient is not there, or the link failed. */
export type FallbackReason = 'offline' | 'link_failed'

/** Paying stopped, and nothing more is offered. */
export interface PayFailure extends DirectPayMessage {
  kind: 'failed'
  /**
   * Whether money may have left the wallet. `no`: the attempt stopped before any payment was
   * made (a `NotSentError`). `maybe`: the payment was made and may have been delivered, so the
   * caller must not start a second one; the wording says so.
   */
  spent: 'no' | 'maybe'
  /** The error's own words (English), when the wording cannot carry them. For logs and diagnosis. */
  detail?: string
}

/** How paying a wallet identity ended, or what the user is asked next. */
export type PayOutcome =
  | { kind: 'paid_live'; ackStatus: string }
  | { kind: 'paid_messagebox' }
  | { kind: 'ask_fallback'; reason: FallbackReason }
  | PayFailure

/**
 * `off`: not receiving; `starting`: setting up receiving, or connecting to the relay;
 * `online`: receiving; `error`: see `error`.
 */
export type DirectPayStatus = 'off' | 'starting' | 'online' | 'error'

/** The part of the manager's state the Receive card is drawn from. */
export interface DirectPayStatusInput {
  status: DirectPayStatus
  /** How this wallet reaches others by identity key; null when it cannot. */
  via: 'messagebox' | 'relay' | null
  /** Why `status` is `error`, for the log; empty otherwise. */
  error: string
  /** Why direct payments are not set up when that is not a failure (no message box); empty otherwise. */
  notice: string
  /**
   * The settings choose the relay but it cannot be reached, so `via` is the message box until it
   * can be. False or absent otherwise.
   */
  relayUnreachable?: boolean
}

/**
 * What the manager's state means. `not_set_up`: receiving is off because there is nothing to
 * signal through, which is not a failure. `failed`: a real error. `online_fallback`: receiving
 * through the message box because the relay the settings choose cannot be reached.
 */
export type DirectPayState =
  | 'off'
  | 'starting'
  | 'online_messagebox'
  | 'online_relay'
  | 'online_fallback'
  | 'not_set_up'
  | 'failed'

/** The Receive tab's card about receiving live payments. */
export interface LiveStatus {
  tone: 'on' | 'off' | 'connecting' | 'error'
  titleKey: TranslationKey
  bodyKey: TranslationKey
  /** The manager's own error text, on `error`, for the log. Not for the user. */
  detail?: string
}
