/**
 * The handle rail's inbox pre-hold pass (offline-settlement spec §4.2/§4.3
 * guard #2; codebase-review mandala-handle-P1-4).
 *
 * `@bsv/mandala`'s own `receiveTokens` (`dist/receive.js` `acceptOne`) calls
 * `wallet.internalizeAction` BEFORE it calls the `settle` hook that finally
 * writes a `token_settlements` row — and `internalizeAction` forces a
 * broadcast attempt of its own via `shareReqsWithWorld`. The only thing
 * standing between that and a real, unmediated broadcast of an unadmitted
 * token transaction is `StorageExpoSQLite.attemptToPostReqsToNetwork`'s
 * lookup of exactly that row. On the FIRST credit of a v2 hand-over message
 * the row does not exist yet, so the guard finds nothing and lets the
 * broadcast through before the issuer's overlay ever got to admit or refuse
 * the transfer. `core/localpay/pending.ts`'s `processPending` closed the same
 * hole for the nearby rail by moving the settlement write ahead of the
 * credit; this file is the handle rail's equivalent, run once per inbox
 * drain, before `createRuntime.ts`'s `receiveFromInbox` ever calls
 * `receiveTokens`.
 *
 * This does NOT reimplement the library's trust logic. The only piece ported
 * here is the mechanical shape of `acceptOne`'s `coverHandover` — parse the
 * AtomicBEEF, merge it into a `Beef`, and hand the linkage/admissions arrays
 * off to `cover` — because `coverHandover` itself is not exported. The
 * verdict is entirely `cover`'s (the same pure, exported COVER walk the real
 * `receiveTokens` runs), and the row it lets through is written by the
 * caller's own `settle` hook, the SAME one `createRuntime.ts` wires as
 * `settleThroughDrain` for the real `receiveTokens` call that follows. Two
 * calls into the same idempotent hook for the same mustSubmit id are exactly
 * the FIX G re-derivation `settlementStore.ts`'s `advanceSettlement` (a CAS)
 * and `upsertSettlement` (never drags `state` backward on conflict) are built
 * to tolerate.
 *
 * A message that will not decode on this side (bad bytes, not a handover, a
 * COVER refusal) is simply left alone: `receiveTokens`'s own `acceptOne` runs
 * the identical pure walk over the identical bytes moments later and, for a
 * hand-over body, reaches `coverHandover` — and therefore any refusal —
 * BEFORE it ever calls `internalizeAction`, so skipping it here costs
 * nothing. Only a message whose evidence WOULD have credited safely, but
 * whose settlement write failed, is dangerous to hand to `receiveTokens`
 * unfiltered — that message is excluded from this pass via the same
 * `processed` dedup set `receiveTokens` already accepts as a message filter
 * (`ReceiveParams.processed`), so it is retried whole on the next drain tick
 * rather than credited on a bare table.
 *
 * One inherent gap: this lists the inbox once, `receiveTokens` lists it
 * again a moment later. A message that arrives in that narrow window is not
 * covered by this pass — it is credited by `receiveTokens` with the
 * library's original ordering, exactly as before this file existed. Closing
 * that would require intercepting inside `acceptOne` itself, which is what
 * the review's alternative (a pre-internalize hook upstream in
 * `@bsv/mandala`) is for.
 */
import { Beef, Transaction } from '@bsv/sdk'
import { MESSAGEBOX } from '@bsv/mandala/constants'
import type { MessageBoxLike, SettleFn } from '@bsv/mandala'
import type { CoverResult } from './types'
import { devLog } from '../logging'

/** The v2 hand-over body fields this pass reads (wire contract v2 §8). Untyped past this: everything else is the caller's / the library's concern. */
interface RawHandoverBody {
  v?: unknown
  kind?: unknown
  assetId?: unknown
  transaction?: unknown
  linkage?: unknown
  admissions?: unknown
}

interface RawInboxMessage {
  messageId: string
  body?: RawHandoverBody
}

/** What one decoded hand-over needs from `settle` — the exact shape `SettleArgs` wants. */
interface DecodedHandover {
  tip: Transaction
  mustSubmit: string[]
  bytesFor: (txid: string) => { beef: number[]; offChainValues: number[] } | undefined
}

/** The bundle shape this pass's injected `cover` reads — mirrors `libCoverArgs`'s own bundle parameter in `createRuntime.ts`. */
export interface PreHoldCoverBundle {
  assetId: string
  beef: Map<string, Transaction>
  linkage: Map<string, number[]>
  admissions: Map<string, { outputsToAdmit: number[]; signature: string; signerKey: string }>
}

/**
 * The pure COVER walk, already crossing the app/lib `@bsv/sdk` duplication
 * seam (see `createRuntime.ts`'s `libCoverArgs` — this pass is handed a
 * closure built from that same helper, never the raw library `cover`, so
 * this file needs no cast of its own).
 */
export type PreHoldCoverFn = (tip: Transaction, bundle: PreHoldCoverBundle) => CoverResult

export interface PreHoldInboxDeps {
  messageBoxClient: MessageBoxLike
  cover: PreHoldCoverFn
  /** The SAME hook `receiveFromInbox` passes to `receiveTokens` as `settle` — `settleThroughDrain`. */
  settle: SettleFn
}

/** Parses one v2 hand-over body into what `settle` needs, or `undefined` if COVER refuses it. Throws on bytes that will not even parse — the caller classifies that as "leave it to the library". */
function decodeHandover(body: RawHandoverBody, cover: PreHoldCoverFn): DecodedHandover | undefined {
  if (typeof body.assetId !== 'string' || body.assetId === '') return undefined
  if (!Array.isArray(body.transaction)) return undefined
  const tip = Transaction.fromAtomicBEEF(body.transaction as number[])

  const beef = new Beef()
  beef.mergeTransaction(tip)
  const txs = new Map<string, Transaction>()
  for (const entry of beef.txs) if (entry.tx) txs.set(entry.txid, entry.tx)

  const linkage = new Map<string, number[]>()
  for (const l of Array.isArray(body.linkage) ? body.linkage : []) {
    if (typeof l?.txid === 'string' && Array.isArray(l.payload)) linkage.set(l.txid, l.payload)
  }
  const admissions = new Map<string, { outputsToAdmit: number[]; signature: string; signerKey: string }>()
  for (const a of Array.isArray(body.admissions) ? body.admissions : []) {
    if (typeof a?.txid === 'string') {
      admissions.set(a.txid, { outputsToAdmit: a.outputsToAdmit, signature: a.signature, signerKey: a.signerKey })
    }
  }

  const result = cover(tip, { assetId: body.assetId, beef: txs, linkage, admissions })
  if (!result.ok) return undefined

  return {
    tip,
    mustSubmit: result.mustSubmit,
    bytesFor: (id: string) => {
      const found = beef.findAtomicTransaction(id)
      if (found == null) return undefined
      return { beef: found.toAtomicBEEF(true), offChainValues: linkage.get(id) ?? [] }
    }
  }
}

/**
 * Runs the pre-hold pass. Returns the ids of messages whose settlement write
 * failed this pass — the caller must keep those out of the `receiveTokens`
 * call that follows (e.g. by adding them to its `processed` set for the
 * duration of that one call, then removing them so the next drain retries).
 *
 * Deliberately best-effort PER MESSAGE and fail-closed PER MESSAGE: one bad
 * or unwritable message never blocks the rest of the inbox, but a message
 * this pass could have safely pre-held is never handed to `receiveTokens`
 * with that write missing.
 */
export async function preHoldInboxSettlements(deps: PreHoldInboxDeps): Promise<Set<string>> {
  const exclude = new Set<string>()
  const messages = (await deps.messageBoxClient.listMessages({
    messageBox: MESSAGEBOX,
    acceptPayments: false
  })) as RawInboxMessage[]

  for (const raw of messages) {
    const body = raw.body
    // v2 + kind:'handover' is the whole version discriminator (receive.js).
    // A v1 body's `covering` is always undefined in `acceptOne`, so its
    // `settle` never runs at all — there is nothing here to pre-hold.
    if (body == null || body.v !== 2 || body.kind !== 'handover') continue

    let decoded: DecodedHandover | undefined
    try {
      decoded = decodeHandover(body, deps.cover)
    } catch (e) {
      devLog(`[mandala] inbox pre-hold could not decode message ${raw.messageId}; leaving it to the library:`, e)
      continue
    }
    if (!decoded) continue // COVER refused it — acceptOne will reach the same refusal before internalizing

    try {
      await deps.settle({ txid: decoded.tip.id('hex'), mustSubmit: decoded.mustSubmit, bytesFor: decoded.bytesFor })
    } catch (e) {
      devLog(
        `[mandala] inbox pre-hold could not write the settlement row for message ${raw.messageId}; holding it back this pass:`,
        e
      )
      exclude.add(raw.messageId)
    }
  }

  return exclude
}
