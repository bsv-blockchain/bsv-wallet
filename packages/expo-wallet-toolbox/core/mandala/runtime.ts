/**
 * MandalaRuntime — the single object the UI layer consumes for stablecoin
 * features. Constructed once in WalletContext (core wiring), exposed via
 * `useMandala()`. Pure types here; the implementation lives in
 * core/mandala/createRuntime.ts (integration) and the hook in
 * core/hooks/useMandala.ts.
 *
 * Design rule (ux §1): the UI never talks to the overlay or the lib directly;
 * everything goes through this surface so failure copy, journaling and
 * state live in one place.
 */
import type {
  AdmissionVerifier,
  CoverResult,
  FetchAdmissionFn,
  SettlementStore,
  TokenHandedOverHook,
  TokenHeldHook,
  TokenSettlementRow,
  TokenSettlementState
} from './types'
import type { LockToPayee, TokenBuildDeps } from '../localpay/build'
import type { CoverVerifier } from './bundle'
import type { VerifyAdmissionFn } from '../localpay/settlementAck'
import type { TokenCreditedHook } from '../localpay/pending'
import type { OfflineTokenDeps } from '../storage/methods/processOfflineActions'
import type { MandalaEndpointConfig } from '../toolboxConfig'

/**
 * Regulatory/registry facts about one asset, for the UI's remaining copy
 * (paused banners, frozen-balance notices, access-mode refusals, admission
 * status). Everything here is best-effort and short-lived (~10s cache in the
 * implementation) — a stale or unreachable overlay reads as the least
 * alarming answer (`false`/`undefined`), never as a thrown error, because
 * this is display copy, not a gate anything transacts against.
 */
export interface TokenAssetStatus {
  /** The issuer has paused this asset. */
  paused: boolean
  /** Sum of amounts across the asset's frozen outpoints, per the overlay's admin state. */
  frozenBaseUnits: number
  /** 'allowlist' | 'denylist', when the overlay reports one. */
  accessMode?: string
  /** This wallet's own identity key, admitted under the asset's issuer registry.
   * `undefined` when the registry is inactive (no membership gate in effect) or unknown. */
  selfAdmitted: boolean | undefined
  /** Same question for another identity key — e.g. a recipient before a send. */
  recipientAdmitted(identityKey: string): Promise<boolean | undefined>
  /** Whether the asset's on-chain label/ticker/decimals resolved (registry lookup + SPV). */
  metadataResolved: boolean
  /** The MessageBox host this deployment's handle rail uses. */
  messageBoxUrl: string
}

export interface TokenAssetInfo {
  assetId: string
  label: string            // e.g. "Acme Dollar"
  ticker: string           // e.g. "USDX"
  decimals: number
  issuerName?: string      // e.g. "Acme Bank" — used in every failure/settling copy
  overlayUrl: string
  overlayIdentityKey: string
}

export interface TokenBalance {
  asset: TokenAssetInfo
  /** Spendable base units (sum of unspent outputs in the token basket). */
  baseUnits: number
  /** Base units in rows whose settlement is not yet 'broadcast' (received offline). */
  unsettledBaseUnits: number
}

export type TokenActivityStatus = 'settling' | 'settled' | 'refused' | 'reversed' | 'stuck'

export interface TokenActivityRow {
  txid: string
  role: 'sent' | 'received'
  asset: TokenAssetInfo
  baseUnits: number
  counterpartyKey?: string
  status: TokenActivityStatus
  at: string               // ISO
  refusedCode?: string
  /** `payloadHash` of the linkage bytes this refusal was recorded against (amendment §9.1/§9.3). */
  refusedPayloadHash?: string
}

/** Handle (MessageBox) rail results — mirror the wallet's existing rail result shapes. */
export type TokenSendResult =
  | {
      kind: 'sent'
      txid: string
      /**
       * The issuer's overlay has this transaction (`admitted`, or `broadcast`
       * on top of it) — because a hand-over that landed while this device had
       * signal is followed straight away by the payer's own submit
       * (`settleNow`). False is not a failure and never a reason to retry the
       * SEND: the money moved at hand-over, and the drain finishes the
       * settlement on its next tick.
       */
      settled: boolean
      /**
       * False when the transaction committed but the recipient's MessageBox
       * notification did not go out (the lib's `TransferResult.notified`).
       *
       * The money is sent either way — the notify is journaled by the lib and
       * retried by `reconcileNotifications` on the next drain tick — but until
       * it lands the recipient has an output nothing has told them to
       * internalize. The UI says "recipient notification pending" rather than
       * implying either that the payment failed (it did not) or that the payee
       * can already see it (they cannot). NEVER a reason to retry the send: a
       * second send would be a second payment.
       */
      notified: boolean
    }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unavailable'; message: string }

/**
 * Where one row stood when `settleNow` let go of it.
 *
 * Every `TokenSettlementState` can come back, because the answer is simply the
 * row's state re-read after the step: `'admitted'`/`'broadcast'` are the two
 * that mean settled, `'refused'`/`'orphaned'` are the overlay's final word, and
 * an unchanged `'handed_over'`/`'held'` means the step stalled and the ordinary
 * drain will try again. `'unavailable'` is the one addition — no such row, no
 * database, or no Mandala deployment on this chain — and is never a verdict
 * about the money.
 */
export type TokenSettleState = TokenSettlementState | 'unavailable'

export interface MandalaRuntime {
  /** Chain gate: mainnet-only in v1 (ux §2). */
  available: boolean
  /**
   * THIS DEVICE's configured Mandala deployment — the §9.10 trust anchor, in
   * the shape every call site that has to state one wants (`verifyFramePayment`'s
   * `opts.asset`, a session's own `asset` block).
   *
   * Exposed because the alternative is each call site reaching for whatever
   * overlay facts are nearest to hand, and the nearest ones are on the incoming
   * FRAME. A frame's `overlayUrl`/`overlayIdentityKey` are the payer's claim;
   * verifying a payer's σ_I against the payer's own key is not a check at all.
   * Every field is `''` when this chain has no Mandala deployment
   * (`available === false`), which no frame can ever equal.
   */
  endpoints: MandalaEndpointConfig
  store: SettlementStore
  /** Assets this wallet currently holds or has ever received. */
  listAssets(): Promise<TokenAssetInfo[]>
  balances(): Promise<TokenBalance[]>
  activity(limit?: number): Promise<TokenActivityRow[]>
  /** Non-terminal rows older than STUCK_AFTER_MS (FIX M). */
  stuck(): Promise<TokenSettlementRow[]>
  /** Handle rail: send to an identity key over MessageBox (lib transferTokens). */
  sendToHandle(args: { assetId: string; recipientIdentityKey: string; baseUnits: number }): Promise<TokenSendResult>
  /** Handle rail: drain the MessageBox inbox (lib receiveTokens), credit, journal. */
  receiveFromInbox(): Promise<{ credited: number; failed: number }>
  /** Nearby rail: the blinded payee lock the localpay token build needs (lib prepareBlindedPayment). */
  lockToPayee: LockToPayee
  /** Pure COVER verifier over local evidence (lib cover), for verify.ts at hand-over. */
  cover(tipTxid: string): Promise<CoverResult>
  /** Run one settlement drain pass now (submit-then-broadcast). */
  drainNow(): Promise<void>
  /**
   * ONE row's settlement step, taken now rather than on the next drain tick
   * (2026-09-15 maintainer refinement to §4.3's "payer's optional submit").
   *
   * Hand-over is still first and still unconditional — this is only ever called
   * AFTER the payee has the bytes (a MessageBox post accepted, a nearby
   * positive ack) — but once the hand-over has landed and this device has
   * signal, there is no reason to make the holder wait a drain interval for
   * their own money to reach the issuer. So this runs exactly what the drain
   * would have run for this txid: COVER, `/submit` parents-first, and a
   * broadcast of the tip only once every ancestor is admitted.
   *
   * **Never a failure path.** It reports where the row ended up; it does not
   * throw, and a caller that cannot reach the overlay simply gets the state it
   * started with back, because the drain still owns the retry. The two states
   * the USER owns (`'built'`, `'parked'`) are returned untouched — FIX F: a
   * payment the payer deliberately withheld is not settled by anybody's
   * optimisation.
   *
   * **Safe to race with the tick drain.** Every advance is a CAS
   * (`advanceSettlement`) and `/submit` is idempotent (FIX C), so the worst a
   * lost race costs is one duplicate submit that returns the same admission.
   * Two overlapping `settleNow` calls for the same txid are coalesced onto one
   * in-flight run and get the same answer.
   */
  settleNow(txid: string): Promise<TokenSettleState>
  /**
   * Drives the LIB's own durable journals once: `reconcileWallet` (retryable
   * refusals, overlay-accepted-but-unbroadcast txs, pending aborts, the stuck
   * `nosend` sweep) and `reconcileNotifications` (recipient notifications a
   * crashed or offline send never delivered).
   *
   * Separate from `drainNow`'s settlement pass because it recovers the HANDLE
   * rail's half-finished state, which has no `token_settlements` row of its
   * own to drain — and it rides the same tick because both are "what this
   * device owes after a reconnect". Best-effort in every direction: never
   * throws, and an unreachable overlay or MessageBox simply leaves the entries
   * journaled for the next pass.
   */
  reconcileJournals(): Promise<void>
  /** Plain reason a recipient string cannot receive tokens, or null (D4 / ux §5.4). */
  recipientRefusal(recipient: string): string | null
  /** Subscribe to changes (balances/activity/settlement state). Returns unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * GET /admin/admission/:txid, mapped and FIX-H-verified against this
   * session's overlay identity key (an unverifiable 'admitted' answer counts
   * as absent). Used by `cancelParkedPayment`'s overlay-authoritative cancel
   * (FIX J) and by `recoverStaleAdmissions`' own recovery pass.
   */
  fetchAdmission: FetchAdmissionFn
  /**
   * FIX C recovery: advances any `handed_over`/`held` row older than one
   * drain interval with no local admission by asking the overlay once per
   * pass. Returns the number of rows advanced. Never throws.
   */
  recoverStaleAdmissions(): Promise<number>
  /**
   * Sweeps abandoned nearby-blinding reservations (a `lockToPayee` call whose
   * payment was never built/committed) older than 24h. Returns the number
   * removed. Never throws.
   */
  pruneBlindingReservations(): Promise<number>
  /** Regulatory/registry facts about `assetId`, from the ~10s cache. */
  assetStatus(assetId: string): Promise<TokenAssetStatus>
  /** Same as `assetStatus`, forcing a fresh read past the cache. */
  refreshAssetStatus(assetId: string): Promise<TokenAssetStatus>

  // ── Injection points ──
  //
  // Everything above is something a screen asks the runtime to DO. Everything
  // below is something the runtime hands to machinery that already exists —
  // the release drain, the nearby build, the frame verifier, the pending
  // queue — so that each of those keeps its own single call site instead of
  // growing a second, Mandala-shaped one. They are on this interface rather
  // than on a wider "wallet runtime" type because the UI assembles some of
  // them (NearbyFlow's build deps) and the wallet shell the rest, and both
  // read the same `useWallet().mandala`.

  /** Token deps for `processOfflineActions`, passed on every drain tick (§4.3). */
  tokenDeps: OfflineTokenDeps
  /** What `buildPaymentFrame` needs for a nearby token payment: `{ store, lockToPayee }`. */
  tokenBuildDeps: TokenBuildDeps
  /** The pure COVER verifier `coverFromFrame` injects when a frame is handed over. */
  coverVerifier: CoverVerifier
  /** FIX H: verifies a counterparty-supplied σ_I (a settlement ack) before it gates anything. */
  verifyAdmissionEntry: VerifyAdmissionFn
  /**
   * The same check, curried onto THIS session's configured overlay identity
   * key — the shape the drain and the frame verifier inject (`AdmissionVerifier`).
   * A caller cannot name the key it wants an entry checked against, which is
   * the point: §9.10's expected signer is configuration, never frame data.
   */
  verifyAdmission: AdmissionVerifier
  /** `processPending`'s token hook: journal a credited frame's settlement row and evidence. */
  onTokenCredited: TokenCreditedHook
  /**
   * RECEIVER, BEFORE `internalizeAction`: writes the `'held'` row and the
   * frame's evidence, so the broadcast guard has something to read the moment
   * the credit forces a broadcast attempt.
   */
  onTokenHeld: TokenHeldHook
  /**
   * PAYER, at park/hold: writes the `'parked'`/`'handed_over'` row and the
   * evidence from the still-PLAINTEXT frame, which is the only moment this
   * device can — `offline_actions.framePayload` is sealed with an in-memory
   * session key a restart forgets.
   */
  onTokenHandedOver: TokenHandedOverHook
}
