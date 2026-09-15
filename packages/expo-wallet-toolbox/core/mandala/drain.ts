/**
 * The wallet half of Mandala offline settlement: cache the evidence a frame
 * carried, then submit-before-broadcast.
 *
 * Two independent halves live here because they are two halves of one rule —
 * *the overlay is the only authority on a final refusal* (FIX D):
 *
 *  · `populateEvidenceFromFrame` / `reconcileSettlements` (FIX G). Every row of
 *    the four settlement tables is re-derivable, offline and idempotently, from
 *    frame bytes already durable in `localpay_pending` (receiver) or
 *    `offline_actions.framePayload` (payer). So these writes are never on the
 *    critical path between "frame received" and "ack sent": they run
 *    best-effort at hold time and again at the start of every drain pass, in
 *    any order, over any subset already done. A crash between "frame persisted"
 *    and "evidence written" self-heals on the next tick with no recovery code.
 *  · `postTokenStep` (§4.3). One step of the release plan for a transaction
 *    that has a `token_settlements` row: COVER, submit every unadmitted
 *    ancestor parents-first, and only then broadcast the tip exactly as a BSV
 *    transaction. A cover hole, a liftable policy refusal and a 503 all come
 *    back as `serviceError` — the row stays non-terminal and the whole prefix
 *    is retried next pass, which is safe because `/submit` is idempotent
 *    (FIX C). Only the overlay's own final verdict burns a row.
 *
 * Everything the drain cannot do offline is injected (`cover`, `submit`,
 * `broadcast`), so this module has no network and no `StorageExpoSQLite`
 * dependency and is unit-testable against an in-memory SQLite.
 */
import { Beef, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { payloadHash } from '@bsv/mandala'
import type { PostOutcome } from '../offline/plan'
import { devLog } from '../logging'
import {
  STUCK_AFTER_MS,
  type AdmissionEntryWire,
  type AdmissionVerifier,
  type CoverFn,
  type EvidenceFrame,
  type EvidenceTokenBlock,
  type SettlementStore,
  type SubmitFn,
  type TokenAdmissionEdge,
  type TokenAdmissionRow,
  type TokenSettlementRole,
  type TokenSettlementRow,
  type TokenSettlementState
} from './types'

/**
 * Re-exported so every existing importer of these two keeps its import site.
 * They live in `./types` now because the payer's hold and the receiver's queue
 * need them too, and neither may depend on this module's runtime.
 */
export type { EvidenceFrame, EvidenceTokenBlock }

// ─────────────────────────────── states ───────────────────────────────

/** Nothing leaves these. Mirrors spec §5's "terminal states never revert". */
export const TERMINAL_SETTLEMENT_STATES: readonly TokenSettlementState[] = ['broadcast', 'refused', 'orphaned']

/** Everything else. FIX M's "stuck" query and the drain's cascade both use it. */
export const NON_TERMINAL_SETTLEMENT_STATES: readonly TokenSettlementState[] = [
  'built',
  'parked',
  'handed_over',
  'held',
  'submitting',
  'admitted'
]

/**
 * The only states a drain pass may claim.
 *
 * `built` and `parked` are the USER's states, never the drain's: a parked
 * payment is one the payer walked away from, and pulling it into a submit set
 * would send money the payer deliberately withheld (spec §5, FIX F). `admitted`
 * is admitted only because a re-submit of already-admitted bytes is the
 * idempotent no-op — it is how a device whose admission cache was cleared
 * recovers without a special path.
 */
const SUBMITTABLE_STATES: TokenSettlementState[] = ['handed_over', 'held', 'submitting', 'admitted']

/** What a proven admission may advance directly, without a submit of its own. */
const PRE_ADMIT_STATES: TokenSettlementState[] = ['handed_over', 'held', 'submitting']

// ───────────────────────────── evidence (FIX G) ─────────────────────────────

/**
 * Every `(child, parent, vout)` token edge in a frame's AtomicBEEF.
 *
 * FIX K: only inputs whose SOURCE OUTPUT decodes as a `MandalaToken` of this
 * frame's `assetId` are edges. A fresh unconfirmed BSV change output funding
 * the fee is not a token ancestor — the release engine already broadcasts such
 * a parent in dependency order, and treating it as a coverage hole would refuse
 * the ordinary case of a payer spending their own change.
 *
 * The whole beef is walked, not just the tip, because COVER has to recurse into
 * ancestors the payer forwarded but never submitted (spec §1.6's 1-hop and
 * 3-hop examples). Unreadable bytes yield no edges rather than throwing: a
 * frame the drain cannot parse is a frame it will simply never cover, and that
 * is a retry, not a refusal.
 */
export function deriveTokenEdges(transaction: Uint8Array, assetId: string): TokenAdmissionEdge[] {
  let beef: Beef
  try {
    beef = Beef.fromBinary(transaction)
  } catch {
    return []
  }
  const edges: TokenAdmissionEdge[] = []
  for (const bt of beef.txs) {
    const tx = bt.tx
    if (!tx) continue
    for (const input of tx.inputs) {
      const parentVout = input.sourceOutputIndex
      const parentTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (!parentTxid || typeof parentVout !== 'number') continue
      const source = input.sourceTransaction ?? beef.findTxid(parentTxid)?.tx
      const output = source?.outputs?.[parentVout]
      if (!output?.lockingScript) continue
      try {
        if (MandalaToken.decode(output.lockingScript).assetId !== assetId) continue
      } catch {
        continue // not a token output at all
      }
      edges.push({ childTxid: bt.txid, parentTxid, parentVout })
    }
  }
  return edges
}

export interface EvidencePopulated {
  admissions: number
  linkage: number
  edges: number
  /**
   * Counterparty-supplied `admissions[]` entries that were NOT cached, because
   * they were signed by some key other than this wallet's configured overlay,
   * failed σ_I verification, or arrived with no verifier to check them (FIX H).
   * Not an error: an unverifiable σ_I is treated as ABSENT, and the ancestor is
   * simply walked and submitted like any other.
   */
  admissionsDropped: number
  /** Non-fatal: this is a cache-population step, so failures are reported, never thrown. */
  errors: string[]
}

/** How `populateEvidenceFromFrame` is told what a σ_I has to be to be believed. */
export interface EvidenceTrustAnchor {
  /**
   * THIS WALLET's configured overlay identity key — never `frame.token
   * .overlayIdentityKey` and never `settlement.overlayIdentityKey`, both of
   * which are counterparty-supplied data (wire contract §9.10).
   */
  overlayIdentityKey?: string
  /** FIX H: the cryptographic check. Absent → nothing is cached. */
  verifyAdmission?: AdmissionVerifier
}

/**
 * `INSERT OR IGNORE` a frame's `admissions[]`, `linkage[]` and derived edges
 * into the three cache tables.
 *
 * **Every admission is verified before it is cached (FIX H).** The cache is not
 * a transcript of what a counterparty said — `admissionStandsIn` lets a cached
 * entry SKIP a `/submit`, and `assembleBundle` forwards cached entries onward
 * as this device's own claim about the chain, so a forged entry landing here
 * would strand a payment that was never admitted and propagate the lie to the
 * next hop. An entry signed by anything but the configured overlay key, or
 * whose σ_I does not verify, is dropped and counted; with no verifier supplied,
 * every entry is dropped, because "no verifier" is "no evidence".
 *
 * Linkage payloads are NOT filtered: they are opaque bytes destined for the
 * overlay's own verifier, prove nothing on their own, and a wrong one can only
 * ever cost a refused `/submit` that the drain records as a refusal for exactly
 * that payload hash.
 *
 * Never throws. A caller reaching this is either holding a payment it has
 * already promised (so a throw would turn a completed credit into a decline —
 * the exact hazard FIX G makes structurally impossible) or is a drain pass that
 * must reach the rest of the queue regardless.
 */
export async function populateEvidenceFromFrame(
  store: SettlementStore,
  frame: EvidenceFrame,
  opts: EvidenceTrustAnchor & {
    now?: () => Date
    /** How this device came by the admissions: forwarded to it, or minted by it. */
    admissionSource?: TokenAdmissionRow['source']
    linkageSource?: 'minted' | 'forwarded'
  } = {}
): Promise<EvidencePopulated> {
  const result: EvidencePopulated = { admissions: 0, linkage: 0, edges: 0, admissionsDropped: 0, errors: [] }
  const token = frame.token
  if (!token) return result
  const at = (opts.now?.() ?? new Date()).toISOString()

  for (const entry of token.admissions ?? []) {
    if (!(await entryIsTrustworthy(entry, opts))) {
      result.admissionsDropped++
      continue
    }
    try {
      await store.putAdmission({
        txid: entry.txid,
        outputsToAdmit: [...entry.outputsToAdmit],
        signatureHex: Utils.toHex(Array.from(entry.signature)),
        signerKey: entry.signerKey,
        source: opts.admissionSource ?? 'bundle',
        obtainedAt: at
      })
      result.admissions++
    } catch (e) {
      result.errors.push(`admission ${entry.txid}: ${messageOf(e)}`)
    }
  }

  for (const entry of token.linkage ?? []) {
    try {
      await store.putLinkage({
        txid: entry.txid,
        payloadBytes: entry.payload,
        overlayUrl: token.overlayUrl,
        overlayIdentityKey: token.overlayIdentityKey,
        source: opts.linkageSource ?? 'forwarded',
        createdAt: at
      })
      result.linkage++
    } catch (e) {
      result.errors.push(`linkage ${entry.txid}: ${messageOf(e)}`)
    }
  }

  try {
    const edges = deriveTokenEdges(frame.transaction, token.assetId)
    await store.putEdges(edges)
    result.edges = edges.length
  } catch (e) {
    result.errors.push(`edges: ${messageOf(e)}`)
  }

  return result
}

/**
 * One durable frame, paired with the txid and role its settlement row needs.
 *
 * The caller supplies these because only it can read them: the receiver's
 * frames are already decoded in `localpay_pending`, while the payer's
 * `offline_actions.framePayload` is the SEALED `bsvpayf1:` string and needs the
 * session pre-shared key to open — which the drain does not, and should not,
 * hold. A payer-side source is therefore contributed by whoever still has the
 * session; a receiver-side one needs nothing.
 */
export interface TokenFrameSource {
  txid: string
  role: TokenSettlementRole
  frame: EvidenceFrame
  counterpartyKey?: string
  amountBaseUnits?: number
  /** Only used when no row exists yet. Defaults per role: sent → handed_over, received → held. */
  state?: TokenSettlementState
}

/**
 * FIX I / FIX G, run at the start of every drain pass.
 *
 * Re-derives a `token_settlements` row for any durable token frame that has
 * lost one (or never got one), and re-populates the evidence cache. This is why
 * `MAX_PENDING_ATTEMPTS` cannot abandon a token payment: the pending queue's
 * retry ceiling governs its own BSV-shaped bookkeeping, while the row that
 * actually decides whether this money settles is re-established here on every
 * tick and is abandoned only by an explicit `refused`/`orphaned` verdict.
 *
 * `upsertSettlement` never writes `state` on conflict, so a later pass can
 * never drag an `admitted` row back to `held`.
 */
export async function reconcileSettlements(
  args: EvidenceTrustAnchor & {
    store: SettlementStore
    sources: readonly TokenFrameSource[]
    now?: () => Date
  }
): Promise<{ derived: number; populated: number; dropped: number; errors: string[] }> {
  const { store, sources } = args
  const out = { derived: 0, populated: 0, dropped: 0, errors: [] as string[] }
  for (const source of sources) {
    const token = source.frame.token
    if (!token) continue
    try {
      const evidence = await populateEvidenceFromFrame(store, source.frame, {
        now: args.now,
        overlayIdentityKey: args.overlayIdentityKey,
        verifyAdmission: args.verifyAdmission
      })
      out.errors.push(...evidence.errors)
      out.dropped += evidence.admissionsDropped
      out.populated++

      const existing = await store.getSettlement(source.txid)
      await store.upsertSettlement({
        txid: source.txid,
        role: source.role,
        assetId: token.assetId,
        state: existing?.state ?? source.state ?? (source.role === 'sent' ? 'handed_over' : 'held'),
        counterpartyKey: source.counterpartyKey,
        amountBaseUnits: source.amountBaseUnits,
        overlayUrl: token.overlayUrl,
        overlayIdentityKey: token.overlayIdentityKey,
        createdAt: existing?.createdAt
      })
      if (!existing) out.derived++
    } catch (e) {
      out.errors.push(`settlement ${source.txid}: ${messageOf(e)}`)
    }
  }
  return out
}

// ───────────────────────────── the drain (§4.3) ─────────────────────────────

export interface TokenStepDeps extends EvidenceTrustAnchor {
  store: SettlementStore
  /** The pure COVER walk over local evidence (spec §1.2). */
  cover: CoverFn
  /** POST /submit for one txid; beef + linkage resolved from the local tables. */
  submit: SubmitFn
  /**
   * Broadcast the tip EXACTLY as a BSV transaction. Injected so this is
   * literally the release engine's own `postOwned`/`postForeign` — a token tip
   * gets no special broadcast path, only a gate in front of it.
   */
  broadcast: (txid: string) => Promise<PostOutcome>
  /**
   * Clear `@bsv/mandala`'s own tx-journal entry for a txid this drain has now
   * really broadcast (the lib's `journalRemove`, over the storage adapter
   * `configureMandala` was given).
   *
   * Injected rather than imported so this module keeps no lib-pipeline
   * dependency — and because the entry it clears is written by a pipeline this
   * module never runs.
   *
   * WHY IT IS HERE AT ALL. The lib's `submitAndBroadcast` journals `'accepted'`
   * and then broadcasts through `createAction({ sendWith })`. In this wallet
   * that broadcast is HELD (guard #2) — the drain owns it — so the lib's own
   * clear either fired on a broadcast that never happened (the 2026-09-15 bug)
   * or, once the lib stops clearing it, never fires at all and leaves the entry
   * for `reconcileWallet` to rebroadcast forever behind the drain's back. The
   * honest clear is this one: the moment the tip actually reaches the network,
   * from the only code that knows it did.
   *
   * Best-effort in the strongest sense — the money is already on chain when
   * this runs, and a stale journal entry costs an idempotent re-broadcast
   * attempt, never a payment.
   */
  journalRemove?: (txid: string) => Promise<void>
  now?: () => Date
}

/**
 * Whether a cached admission may stand in for a submit.
 *
 * **Both halves are required, and the cryptographic one is not optional.** The
 * structural half — a non-empty admitted set, signed by the wallet's CONFIGURED
 * overlay identity key — only says the entry is addressed to the right overlay.
 * It says nothing about whether that overlay actually signed it, and this entry
 * may have arrived on a frame a counterparty composed. Skipping a `/submit` on
 * a forged entry is how a transaction the overlay has never seen reaches a real
 * broadcast: the drain would mark the ancestor `admitted` from the lie, walk
 * past it, and put an unadmitted chain on chain.
 *
 * So `deps.verifyAdmission` — σ_I checked against the configured key — gates
 * every skip, and its ABSENCE means "never skip": the ancestor is submitted,
 * which is free (`/submit` is idempotent, FIX C) and always correct. The
 * configured key comes from `deps`, never from `settlement.overlayIdentityKey`:
 * that column is re-derived from counterparty frame bytes by
 * `reconcileSettlements`, so anchoring trust in it would let the frame name its
 * own signer (wire contract §9.10).
 */
async function admissionStandsIn(
  row: TokenAdmissionRow | undefined,
  anchor: EvidenceTrustAnchor
): Promise<boolean> {
  if (row === undefined) return false
  if (row.signatureHex.length === 0 || row.outputsToAdmit.length === 0) return false
  return await entryIsTrustworthy(
    {
      txid: row.txid,
      outputsToAdmit: row.outputsToAdmit,
      signature: hexToBytes(row.signatureHex),
      signerKey: row.signerKey
    },
    anchor
  )
}

/**
 * FIX H in one predicate: is this σ_I the configured overlay's own?
 *
 * False for every way the answer can be "not proven" — a foreign signer key, a
 * missing verifier, a missing configured key, a signature that does not verify,
 * or a verifier that threw. The caller's move is identical in all of them
 * (treat the entry as absent and submit), which is why they collapse to one
 * boolean rather than a taxonomy nobody branches on.
 */
async function entryIsTrustworthy(entry: AdmissionEntryWire, anchor: EvidenceTrustAnchor): Promise<boolean> {
  const configured = anchor.overlayIdentityKey
  if (!configured || !anchor.verifyAdmission) return false
  if (entry.signerKey.toLowerCase() !== configured.toLowerCase()) return false
  try {
    return (await anchor.verifyAdmission(entry)) === true
  } catch {
    return false
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : ''
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    out[i] = Number.isNaN(byte) ? 0 : byte
  }
  return out
}

/**
 * One plan step for a transaction that has a `token_settlements` row.
 *
 * Reached ONLY from `processOfflineActions`'s own per-step loop, which itself
 * runs only from the drain — never from `finalizeDelivery`, never from
 * `internalizeAction`'s forced-broadcast path. That, plus the token guard in
 * `StorageExpoSQLite.attemptToPostReqsToNetwork`, is what makes an unadmitted
 * token broadcast unreachable rather than merely discouraged.
 *
 * Returns the unchanged `PostOutcome` shape, so the existing `applyOutcome`
 * cascade and requeue logic need no token-specific branch of their own.
 */
export async function postTokenStep(
  deps: TokenStepDeps,
  settlement: TokenSettlementRow,
  step: { txid: string; owned: boolean }
): Promise<PostOutcome> {
  const { store } = deps
  const now = deps.now ?? (() => new Date())
  const tip = step.txid

  const cover = await deps.cover(tip)
  if (!cover.ok) {
    // An ancestor is still missing. Never a local refusal — the overlay is the
    // only authority on a final verdict (FIX D) — so the row stays exactly
    // where it was and the next pass tries again. Said out loud: a silent
    // stall here is what hid the 2026-09-15 fee-parent hole for four minutes.
    devLog(`[mandala] cover of ${tip} incomplete (${cover.reason}); its settlement step is deferred`)
    return 'serviceError'
  }

  for (const ancestorTxid of cover.mustSubmit) {
    const before = await store.getSettlement(ancestorTxid)

    // A row the USER owns must never be submitted by a drain pass, and an
    // anomaly that puts one in a submit set must not be worked around
    // silently — stall the whole step so the next pass (or a human) sees it
    // still waiting rather than a payment the payer deliberately withheld
    // going out (FIX F, spec §5's ownership column).
    if (before && (before.state === 'built' || before.state === 'parked')) return 'serviceError'

    // An ancestor this device has already seen a final verdict for can never
    // become valid: re-submitting would only fetch the same persisted verdict
    // back ("verdict wins", wire contract §2). Poison the tip from local
    // knowledge instead of over the network.
    if (before && (before.state === 'refused' || before.state === 'orphaned')) {
      if (ancestorTxid !== tip) {
        await store.advanceSettlement(tip, [...NON_TERMINAL_SETTLEMENT_STATES], 'orphaned', {
          poisonedByTxid: ancestorTxid
        })
      }
      return before.state === 'orphaned' ? 'doubleSpend' : 'invalidTx'
    }

    const cached = await store.getAdmission(ancestorTxid)
    if (await admissionStandsIn(cached, deps)) {
      await store.advanceSettlement(ancestorTxid, PRE_ADMIT_STATES, 'admitted', {
        admissionOutputs: cached?.outputsToAdmit,
        admissionSignatureHex: cached?.signatureHex
      })
      continue
    }

    await store.advanceSettlement(ancestorTxid, SUBMITTABLE_STATES, 'submitting')
    const verdict = await deps.submit(ancestorTxid)

    if (verdict.kind === 'admitted') {
      await store.putAdmission({
        txid: ancestorTxid,
        outputsToAdmit: verdict.outputsToAdmit,
        signatureHex: verdict.signatureHex,
        signerKey: verdict.signerKey,
        source: 'submitted',
        obtainedAt: now().toISOString()
      })
      await store.advanceSettlement(ancestorTxid, SUBMITTABLE_STATES, 'admitted', {
        admissionOutputs: verdict.outputsToAdmit,
        admissionSignatureHex: verdict.signatureHex
      })
      continue
    }

    if (verdict.kind === 'unavailable') {
      devLog(`[mandala] /submit of ${ancestorTxid} unavailable (${verdict.code}); the step is retried next pass`)
      // Liftable policy refusal or infra fault. Put the row back where it was
      // and stall the WHOLE step — never partially advance a chain past a
      // liftable stall; the whole prefix is retried next pass, idempotently.
      if (before && SUBMITTABLE_STATES.includes(before.state)) {
        await store.advanceSettlement(ancestorTxid, ['submitting'], before.state)
      }
      return 'serviceError'
    }

    // A final verdict for THIS txid. Evicted means it was admitted and then
    // undone (inputs restored overlay-side); refused means it never was.
    const to: TokenSettlementState = verdict.kind === 'evicted' ? 'orphaned' : 'refused'
    // Amendment §9.1/§9.3: a persisted refusal is keyed by (txid, payloadHash),
    // not by txid alone, so the row records which payload it was refused
    // FOR — the same bytes `deps.submit` read from this ancestor's own linkage
    // row — alongside the code, so the UI can say "refused for this payload"
    // rather than implying the txid itself is universally dead. Best-effort:
    // a lookup fault must never block recording the refusal itself.
    let refusedPayloadHash: string | undefined
    if (verdict.kind === 'refused') {
      try {
        const linkage = await store.getLinkage(ancestorTxid)
        if (linkage) refusedPayloadHash = payloadHash(linkage.payloadBytes)
      } catch {
        // Best-effort hint only; the refusal itself is recorded regardless.
      }
    }
    await store.advanceSettlement(ancestorTxid, [...NON_TERMINAL_SETTLEMENT_STATES], to, {
      refusedCode: verdict.kind === 'refused' ? verdict.code : undefined,
      refusedPayloadHash,
      poisonedByTxid: verdict.kind === 'evicted' ? ancestorTxid : undefined
    })
    if (ancestorTxid !== tip) {
      // The tip spends the dead ancestor, so it can never be valid. The broad
      // children-first cascade over every local spender is the caller's
      // unchanged `applyOutcome`; this mirrors the verdict onto the one row
      // that owns the token payment's state.
      await store.advanceSettlement(tip, [...NON_TERMINAL_SETTLEMENT_STATES], 'orphaned', {
        poisonedByTxid: ancestorTxid
      })
    }
    return verdict.kind === 'evicted' ? 'doubleSpend' : 'invalidTx'
  }

  // Every ancestor in mustSubmit is admitted. Only now is a broadcast honest.
  const outcome = await deps.broadcast(tip)
  if (outcome === 'success') {
    await store.advanceSettlement(tip, ['admitted', 'submitting', 'held', 'handed_over'], 'broadcast')
    // This is the one moment anything in this wallet may honestly say the tip
    // was broadcast, so it is the one place the lib's journal entry for it may
    // be cleared. Guarded rather than awaited-and-trusted: the row is already
    // `broadcast` and the transaction is already out, and no journal fault may
    // turn that into anything other than `'success'`.
    try {
      await deps.journalRemove?.(tip)
    } catch (e) {
      // The entry stays; `reconcileWallet` finds the tx already broadcast and
      // clears it then. Never a reason to report a delivered payment as failed.
      console.warn(`[mandala] broadcast ${tip} but could not clear its journal entry:`, messageOf(e))
    }
  }
  return outcome
}

// ─────────────────────────── FIX I / FIX M helpers ───────────────────────────

/**
 * Failures that must never be allowed to abandon a token payment (FIX I).
 *
 * `MAX_PENDING_ATTEMPTS` burns an attempt on ANY `internalizeAction` failure,
 * including a transient `Block header not found for height N` from a
 * fresh-block BUMP this device has not caught up on yet. That is a header lag,
 * not a bad frame: the money is real and the next tick will credit it. A
 * structurally bad BEEF is the opposite, and is deliberately NOT matched here —
 * failure-matrix row 7's "ask the sender to send it again" is for exactly that
 * case and nothing else.
 */
const RETRIABLE_INTERNALIZE_PATTERNS: readonly RegExp[] = [
  /header not found/i,
  /no header/i,
  /chain ?tracker/i,
  /network request failed/i,
  /timed? ?out/i,
  /econnreset|econnrefused|enotfound|fetch failed/i,
  // `processPending`'s own pre-internalize settlement write (§4.2/§4.3 guard
  // #2). A failure there is a local storage fault, not a bad frame: the money
  // is real, the frame is durable, and the next tick tries the same write
  // again. Burning the ceiling on it would abandon a good payment for the
  // exact reason FIX I exists — see `SETTLEMENT_PREWRITE_FAILURE`.
  /settlement row before crediting/i
]

export function isRetriableInternalizeFailure(reason: string | undefined): boolean {
  if (!reason) return false
  return RETRIABLE_INTERNALIZE_PATTERNS.some(p => p.test(reason))
}

/**
 * FIX M: rows that have been waiting past the bound, for the UI to name.
 *
 * Non-terminal by `state` and old by `createdAt` — the user-facing claim is
 * "this payment has been waiting to settle for over three days", which is about
 * the payment's age, not about when the drain last touched it. Every
 * non-terminal state is included; a caller that wants only the drain-owned ones
 * can narrow with `SUBMITTABLE_STATES`' public sibling,
 * `NON_TERMINAL_SETTLEMENT_STATES`, which is exported beside it.
 */
export async function listStuckSettlements(
  store: SettlementStore,
  now: number = Date.now(),
  olderThanMs: number = STUCK_AFTER_MS
): Promise<TokenSettlementRow[]> {
  const rows = await store.listSettlements({ state: [...NON_TERMINAL_SETTLEMENT_STATES] })
  return rows.filter(r => {
    const at = Date.parse(r.createdAt)
    return Number.isFinite(at) && now - at >= olderThanMs
  })
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
