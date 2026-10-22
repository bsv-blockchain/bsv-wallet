/**
 * MandalaRuntime — the single object the UI layer consumes for stablecoin
 * features. Constructed once in WalletContext (core wiring), exposed via
 * `useMandala()`. Pure types here; the implementation lives in
 * core/mandala/createRuntime.ts and the hook in ui/hooks/useMandala.ts.
 *
 * Design rule (ux §1): the UI never talks to the overlay, the color module or
 * the lib directly; everything goes through this surface so failure copy,
 * journaling and state live in one place.
 *
 * Since 1Color (plan 07): the color permission module holds every token and
 * all evidence; the runtime is a thin host over the module (`settle`,
 * `handoffEvidence`), `@bsv/mandala` (hand-over send/receive, deploy reads)
 * and the wallet's own `color_transfers` journal. Token amounts are exact
 * `bigint` everywhere on this surface (IC §0).
 */
import type { HandoverResult } from '@bsv/mandala'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import type { TransferJournal } from './transferJournal'
import type { ColorTransferRail, ColorTransferRole, ColorTransferRow, ColorTransferState } from './types'

/** Display metadata of one asset, from its deploy tx (W7). Untrusted display data: the full `assetId` is always available. */
export interface TokenAssetInfo {
  assetId: string
  label: string // e.g. "Acme Dollar"; the short asset id when unresolved
  ticker: string // e.g. "USDX"; '' when unresolved
  decimals: number // 0..18; 0 when unresolved
  issuerName?: string
  /** The deploy was read and names this wallet's overlay. False means every field above is a fallback. */
  resolved: boolean
}

/**
 * One held asset's figures (W10).
 *
 * `units` is the exact `p color balance <assetTag>` sum: everything available
 * to spend, INCLUDING offline credits (0207:396-404). `offlineUnits` is the
 * part of it the inventory tags `color_offline` — accepted, spendable, but not
 * yet settled with the issuer's overlay. It is never more than `units`; the
 * settled part is `units - offlineUnits`. Never sum the two.
 */
export interface TokenBalance {
  asset: TokenAssetInfo
  units: bigint
  offlineUnits: bigint
}

/**
 * How a journal row reads on the activity list. `settling` covers every
 * non-terminal state; `stuck` is a non-terminal row older than STUCK_AFTER_MS.
 * A cancelled send never appears (the money never moved).
 */
export type TokenActivityStatus = 'settling' | 'settled' | 'refused' | 'stuck'

export interface TokenActivityRow {
  txid: string
  role: ColorTransferRole
  asset: TokenAssetInfo
  units: bigint
  counterpartyKey?: string
  status: TokenActivityStatus
  at: string // ISO
  refusedCode?: string
  rail: ColorTransferRail
}

/**
 * Regulatory/registry facts about one asset, for the UI's remaining copy
 * (paused banners, frozen-balance notices, access-mode refusals, admission
 * status). Everything here is best-effort and short-lived (~10s cache): a
 * stale or unreachable overlay reads as the least alarming answer
 * (`false`/`undefined`), never as a thrown error, because this is display
 * copy, not a gate anything transacts against.
 */
export interface TokenAssetStatus {
  /** The issuer has paused this asset. */
  paused: boolean
  /** Exact sum of amounts across the asset's frozen outpoints, per the overlay's admin state. */
  frozenUnits: bigint
  /** 'allowlist' | 'denylist', when the overlay reports one. */
  accessMode?: string
  /** This wallet's own identity key, admitted under the issuer registry; `undefined` when no gate is live or unknown. */
  selfAdmitted: boolean | undefined
  /** Same question for another identity key — e.g. a recipient before a send. */
  recipientAdmitted(identityKey: string): Promise<boolean | undefined>
  /** Whether the asset's on-chain label/ticker/decimals resolved. */
  metadataResolved: boolean
  /** The MessageBox host this deployment's handle rail uses. */
  messageBoxUrl: string
}

/** Handle (MessageBox) rail results. */
export type TokenSendResult =
  /**
   * The hand-over is built and journaled. `settled`: the overlay admitted it
   * before the call returned. `notified: false`: the MessageBox delivery did
   * not go through; the tick redelivers it. Neither is ever a reason to send
   * again — a second send is a second payment.
   */
  | { kind: 'sent'; txid: string; settled: boolean; notified: boolean }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unavailable'; message: string }

/** Where one row stood when `settleNow` let go of it; `'unavailable'` is no row/database/deployment, never a verdict. */
export type TokenSettleState = ColorTransferState | 'unavailable'

export interface TokenHoldingsReview {
  settled: number
  refused: number
  pending: number
  /** The overlay could not be asked; nothing was decided. */
  unreachable: boolean
}

/** What the nearby rail (localpay build, payer hold, payee pending) is handed by the runtime. */
export interface NearbyTokenDeps {
  /** PAYER: build and sign the module hand-over bound to the session's remittance (Task 15). */
  handover(a: {
    assetId: string
    units: bigint
    recipientKey: string
    derivationPrefix: string
    derivationSuffix: string
    note?: string
  }): Promise<HandoverResult>
  /** PAYER: the frame was handed over (or parked) (Task 15). */
  onHandedOver(txid: string, state: 'parked' | 'handed_over'): Promise<void>
  /** PAYEE: the receipt internalize settled either way (Task 16). */
  onReceived(
    a: {
      txid: string
      assetId: string
      units: bigint
      counterpartyKey: string
      outputIndex: number
      declarationTx?: string
    },
    outcome: { ok: true } | { ok: false; code: string; final: boolean }
  ): Promise<void>
}

export interface MandalaRuntime {
  /** Endpoints, the color module, its provider and a wallet database are all present. */
  available: boolean
  /**
   * THIS DEVICE's configured Mandala deployment. Every field is `''` when this
   * chain has none (`available === false`), which no frame can ever equal.
   */
  endpoints: MandalaEndpointConfig
  /**
   * The `color_transfers` journal: the one key for the broadcast hold and the
   * abort refusal. Without a database every method rejects; it never reads as
   * "no row".
   */
  journal: TransferJournal

  /** Assets this wallet holds (any inventory record) or has ever journaled. */
  listAssets(): Promise<TokenAssetInfo[]>
  /** One row per asset with a value record in the inventory. Rejects (never a partial figure) when a read fails. */
  balances(): Promise<TokenBalance[]>
  /** Journal rows, newest first, cancelled sends omitted. */
  activity(limit?: number): Promise<TokenActivityRow[]>
  /** Non-terminal journal rows older than STUCK_AFTER_MS. */
  stuck(): Promise<ColorTransferRow[]>
  /** Regulatory/registry facts about `assetId`, from the ~10s cache. */
  assetStatus(assetId: string): Promise<TokenAssetStatus>
  /** Same as `assetStatus`, forcing a fresh read past the cache. */
  refreshAssetStatus(assetId: string): Promise<TokenAssetStatus>
  /** Caches a received receipt's attested deploy tx for offline metadata reads (W7). Never throws. */
  rememberDeploy(declarationTxHex: string): Promise<void>
  /** Plain reason a recipient string cannot receive tokens, or null. Sending to self is allowed. */
  recipientRefusal(recipient: string): string | null
  /** Subscribe to changes (balances/activity/settlement state). Returns unsubscribe. */
  subscribe(listener: () => void): () => void

  /** One row's settlement through `color.settle({ txids })`; built/parked rows are returned untouched (Task 12). */
  settleNow(txid: string): Promise<TokenSettleState>
  /** Bare `color.settle()`, single-flight; returns how many journal rows changed (Task 12). */
  settleAll(): Promise<number>
  /** `settleAll` plus a count of where every row stands (Task 12). */
  reviewTokenHoldings(): Promise<TokenHoldingsReview>
  /** Whether the overlay already admitted this hand-over; `undefined` when it cannot be asked (Task 12). */
  isHandoverAdmitted(txid: string): Promise<boolean | undefined>
  /** Journals held 1Color receipts that have no row (held when `color_offline`, else settled) (Task 12). */
  reconcileHeld(txids: readonly string[]): Promise<void>
  /** Handle rail: hand over to an identity key and deliver over MessageBox (Task 13). */
  sendToHandle(a: {
    assetId: string
    recipientIdentityKey: string
    units: bigint
    note?: string
  }): Promise<TokenSendResult>
  /** Handle rail: drain the `mandala-color` box. `incomplete`: the box could not be read (Task 13). */
  receiveFromInbox(): Promise<{ credited: number; failed: number; incomplete?: true }>
  /** Re-deliver a sent hand-over over MessageBox. Never contacts the overlay (Task 13). */
  resendTransfer(txid: string): Promise<'resent' | 'not-found' | 'unavailable'>
  /** One drain pass: redeliver, settle, reconcile held. Never throws (Task 17). */
  tick(): Promise<void>
  nearby: NearbyTokenDeps
}
