/**
 * Shared types for Mandala stablecoin settlement in the wallet.
 *
 * Source of truth: the offline-settlement spec (recipient submits; σ_I per
 * input txid with recursive walk-back; idempotent /submit) and the
 * wire contract v2. Pure types only — no runtime, no imports from storage,
 * so every module (stores, drain, codec, verifier, UI) can depend on this
 * file without creating cycles.
 */

/** token_settlements.state — one row per token tx per party (spec §5). */
export type TokenSettlementState =
  | 'built'
  | 'parked'
  | 'handed_over'
  | 'held'
  | 'submitting'
  | 'admitted'
  | 'broadcast'
  | 'refused'
  | 'orphaned'

export type TokenSettlementRole = 'sent' | 'received'

export interface TokenSettlementRow {
  txid: string
  role: TokenSettlementRole
  assetId: string
  state: TokenSettlementState
  counterpartyKey?: string
  amountBaseUnits?: number
  overlayUrl: string
  overlayIdentityKey: string
  /** outputsToAdmit once known (from our own submit, a bundle, or a fetch). */
  admissionOutputs?: number[]
  /** σ_I over THIS txid once known (DER hex). */
  admissionSignatureHex?: string
  refusedCode?: string
  /**
   * `payloadHash` of the off-chain linkage bytes this device submitted when
   * the overlay returned `refusedCode` (amendment v2.1 §9.1/§9.3). A refusal
   * is keyed by `(txid, payloadHash)`, not by txid alone, so the UI needs this
   * alongside `refusedCode` to say "refused for THIS payload" rather than
   * implying every payload for this txid is dead. Set only alongside
   * `refusedCode`; absent when this device held no linkage bytes to hash.
   */
  refusedPayloadHash?: string
  poisonedByTxid?: string
  /**
   * The `createAction`/`signAction` **reference** of the wallet action that
   * built this transaction, when this device is the one that built it.
   *
   * Recorded so an `abortAction` can be recognised for what it is. A token
   * payment is signed `noSend` and handed over BEFORE anything is broadcast,
   * so for a window the only thing holding its inputs is a live noSend action
   * — and `abortAction(reference)` releases those inputs as spendable. Once
   * the overlay has admitted the transaction (it broadcasts on admission) that
   * release is a double spend waiting to happen: the next send reuses a coin
   * that is already spent on chain, and the overlay refuses the child with
   * `ERR_INPUT_SPENT`. That is the 2026-09-15 incident, and the reference is
   * what lets `wrapAbortActionForSettlements` refuse the abort instead.
   *
   * Absent for rows this device did not build (every `received` row) and for
   * rows written before the column existed — an unknown reference is never a
   * reason to refuse an abort.
   */
  reference?: string
  createdAt: string
  updatedAt: string
}

/** token_admissions — cache of AdmissionEntry values this device has seen. */
export interface TokenAdmissionRow {
  txid: string
  outputsToAdmit: number[]
  signatureHex: string
  signerKey: string
  source: 'minted' | 'bundle' | 'submitted' | 'fetched'
  obtainedAt: string
}

/** token_admission_edges — child spends parent:vout (token inputs only). */
export interface TokenAdmissionEdge {
  childTxid: string
  parentTxid: string
  parentVout: number
}

/** token_linkage_payloads — off-chain linkage bytes for UNADMITTED chain txs. */
export interface TokenLinkageRow {
  txid: string
  payloadBytes: Uint8Array
  overlayUrl: string
  overlayIdentityKey: string
  source: 'minted' | 'forwarded'
  createdAt: string
}

/** Wire-contract v2 §2: what the overlay answered for one /submit. */
export type OverlayVerdict =
  | { kind: 'admitted'; outputsToAdmit: number[]; signatureHex: string; signerKey: string }
  | { kind: 'refused'; code: string; spendTxid?: string }        // final (400) — terminal
  | { kind: 'evicted' }                                           // 410 — terminal, inputs restored
  | { kind: 'unavailable'; code: string; retryable: true }        // 409 liftable or 503 — retry

/** An AdmissionEntry as carried on the wire (frame v4 `admissions[]`). */
export interface AdmissionEntryWire {
  txid: string
  outputsToAdmit: number[]
  signature: Uint8Array
  signerKey: string
}

/** Result of the pure COVER walk (spec §1.2). mustSubmit is parents-first, tip last. */
export type CoverResult =
  | { ok: true; mustSubmit: string[] }
  | { ok: false; reason: 'uncovered_ancestor' | 'unsafe_asset' | 'shape' }

/**
 * Storage-facing API for the four settlement tables. Implemented in
 * core/mandala/settlementStore.ts over StorageExpoSQLite's connection.
 * Every write is idempotent (INSERT OR IGNORE / keyed UPDATE) — spec FIX G.
 */
export interface SettlementStore {
  // token_settlements
  getSettlement(txid: string): Promise<TokenSettlementRow | undefined>
  /**
   * The row whose `reference` is this wallet action's, or undefined.
   *
   * The abort guard's only question, and it is asked on the hot path of every
   * `abortAction` the wallet makes — including plain BSV ones, which have no
   * row at all — so it is one indexed statement rather than a scan.
   */
  getSettlementByReference(reference: string): Promise<TokenSettlementRow | undefined>
  listSettlements(filter?: { state?: TokenSettlementState[]; role?: TokenSettlementRole }): Promise<TokenSettlementRow[]>
  upsertSettlement(row: Omit<TokenSettlementRow, 'createdAt' | 'updatedAt'> & { createdAt?: string }): Promise<void>
  /** Single-statement state advance; returns false if the row was not in one of `from`. */
  advanceSettlement(txid: string, from: TokenSettlementState[], to: TokenSettlementState, patch?: Partial<TokenSettlementRow>): Promise<boolean>
  // token_admissions
  getAdmission(txid: string): Promise<TokenAdmissionRow | undefined>
  putAdmission(row: TokenAdmissionRow): Promise<void>
  // token_admission_edges
  putEdges(edges: TokenAdmissionEdge[]): Promise<void>
  parentsOf(childTxid: string): Promise<TokenAdmissionEdge[]>
  // token_linkage_payloads
  getLinkage(txid: string): Promise<TokenLinkageRow | undefined>
  putLinkage(row: TokenLinkageRow): Promise<void>
}

// ──────────────────── the frame, structurally (FIX G supply) ────────────────────

/**
 * The token block of a payment frame, as the settlement machinery reads it.
 *
 * Structural rather than an import of `localpay/codec`'s `TokenPayment` on
 * purpose: this file may not depend on the codec (it is the leaf every other
 * module imports), and describing the shape here means the drain, the payer's
 * hold and the receiver's queue all agree on one type without a cycle.
 * `admissions[]` is optional so a v3 frame — linkage and edges only — still
 * type-checks through the same path.
 */
export interface EvidenceTokenBlock {
  assetId: string
  overlayUrl: string
  overlayIdentityKey: string
  linkage: readonly { txid: string; payload: Uint8Array }[]
  admissions?: readonly AdmissionEntryWire[]
}

/** Satisfied by `PaymentFrame` from `localpay/codec`. */
export interface EvidenceFrame {
  kind?: string
  /**
   * Optional here and required on `PaymentFrame`: a settlement row wants it for
   * `counterpartyKey`, but nothing structural depends on its presence, and the
   * drain re-derives rows from frames it has only the token block of.
   */
  senderIdentityKey?: string
  /**
   * Which output of the atomic transaction is the payee's. Present on every
   * `PaymentFrame`; optional here because the drain re-derives rows from frames
   * it has only the token block of. Read as 0 when absent — the nearby build
   * never randomises outputs, so the payee's is always the first.
   */
  outputIndex?: number
  token?: EvidenceTokenBlock
  /** AtomicBEEF. The only place the edge graph can come from, offline. */
  transaction: Uint8Array
}

// ─────────────────────── FIX H: the trust anchor, injected ───────────────────

/**
 * Verifies one counterparty-supplied `AdmissionEntry`'s σ_I — cryptographically,
 * against the wallet's OWN CONFIGURED overlay identity key, which the
 * implementation closes over.
 *
 * Injected rather than imported because the σ_I digest is the overlay's own and
 * lives in `@bsv/mandala`, so the wallet and the overlay cannot disagree about
 * what is signed. Wire contract §9.10: the expected signer key comes from the
 * verifier's own configuration; an `overlayIdentityKey` that arrived on a frame
 * or sits on a settlement row is DATA and can never be the anchor.
 *
 * Returns a plain boolean for every failure there is — a malformed signature, a
 * foreign key, an empty admitted set — because FIX H treats an unverifiable σ_I
 * as ABSENT, never as a decline.
 */
export type AdmissionVerifier = (entry: AdmissionEntryWire) => boolean | Promise<boolean>

// ───────────────────────── settlement-durability hooks ─────────────────────────

/**
 * RECEIVER, called BEFORE `wallet.internalizeAction` (§4.2, §4.3 guard #2).
 *
 * Writes the `token_settlements` row (state `'held'`) and the frame's evidence.
 * It has to run first because the guard that stops an unadmitted token
 * broadcast — `attemptToPostReqsToNetwork`'s `token_settlements` lookup — reads
 * that row, and `internalizeAction` triggers a forced broadcast of its own. A
 * row written only AFTER the credit fails open on the very first internalize,
 * which is the one moment it matters.
 *
 * A throw therefore means "do not credit yet": the frame is already durable in
 * `localpay_pending`, so the next tick retries the whole step.
 */
export type TokenHeldHook = (frame: EvidenceFrame, txid: string) => Promise<void>

/** Which side of the payer's own fork a hand-over landed on. */
export type TokenHandoverState = 'parked' | 'handed_over'

/**
 * PAYER, called at park/hold time with the PLAINTEXT frame.
 *
 * `offline_actions.framePayload` holds the frame SEALED with the nearby
 * session's pre-shared key, and that key is in-memory only — so a payer that
 * restarts can no longer open its own frame, and a settlement row derived only
 * from it would never exist. This hook is handed the frame while it is still
 * open, so the row and the evidence are durable independently of the PSK.
 *
 * Best-effort at the call site: the queue row is written first and is the
 * durable fact.
 */
export type TokenHandedOverHook = (
  frame: EvidenceFrame,
  txid: string,
  state: TokenHandoverState,
  /**
   * The `createAction` reference of the action that built `txid`, when the
   * caller still holds it. Recorded on the row so an abort of that action can
   * be refused once the overlay has the bytes — see `TokenSettlementRow.reference`.
   * Optional: a caller that does not have one simply leaves the column null,
   * which reads as "unknown reference" and blocks nothing.
   */
  reference?: string
) => Promise<void>

/** Injected by the drain: run COVER for a tip against local evidence. */
export type CoverFn = (tipTxid: string) => Promise<CoverResult>
/** Injected by the drain: POST /submit for one txid (beef + linkage resolved from local tables). */
export type SubmitFn = (txid: string) => Promise<OverlayVerdict>
/** Injected: GET /admin/admission/:txid (undefined = 404 / unknown). */
export type FetchAdmissionFn = (overlayUrl: string, txid: string) => Promise<OverlayVerdict | undefined>

/** FIX M: a non-terminal row older than this is surfaced as "stuck". */
export const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The basket Mandala token outputs (and change) live in. Deliberately
 * `'p '`-prefixed (BRC-99 P-basket) so `WalletPermissionsManager` routes every
 * `listOutputs`/`createAction`(basket output)/`internalizeAction`(basket
 * insertion)/`relinquishOutput` call against it through
 * `MandalaTokenModule` (schemeID 'mandala' = `'p mandala'.split(' ')[1]`),
 * regardless of originator. A flat, single basket for every asset -- unlike
 * BTMS's per-asset `'p btms <assetId>'` baskets, Mandala keeps one cardinality
 * for the whole scheme. Was `'mandala-tokens'` (not P-routed, no gate at all);
 * see core/mandala/basketMigration.ts for the one-time rename and
 * offline-settlement-final.md §8 for the rationale.
 */
export const MANDALA_BASKET = 'p mandala'

/**
 * The action label every token transfer carries, on every rail.
 *
 * `@bsv/mandala`'s own `transferTokens` / `receiveTokens` write it, and the
 * home screen recognises a token row by it ALONE — by label, not by holdings,
 * so a user who sends their last coin keeps the denomination across their
 * history. The nearby rail's token actions have to write the same label, or
 * they render as BSV rows: the counterparty's abbreviated key over "+0 sats"
 * (2026-09-16).
 */
export const MANDALA_ACTION_LABEL = 'mandala'
