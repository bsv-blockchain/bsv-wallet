/**
 * Guard #4: the action behind a handed-over or settled token payment may not
 * be aborted.
 *
 * THE 2026-09-15 INCIDENT, in one paragraph. A token transfer is built and
 * signed `noSend`, handed to the payee, and only then submitted to the issuer's
 * overlay — which BROADCASTS on admission. For the window between "signed" and
 * "our own request reaches the network", the only thing holding this device's
 * inputs is a live `noSend` wallet action, and `abortAction(reference)` frees
 * those inputs as spendable. On that day a transfer was admitted (and therefore
 * broadcast by the overlay) and 0.7 s later the wallet aborted its own action:
 * `proven_tx_reqs` went `nosend → abortAction → invalid`, `transactions.status`
 * went `failed`, and the input coin came back spendable although it was spent on
 * chain. The next send reused it and the overlay refused the child with
 * `ERR_INPUT_SPENT` — surfaced to the user as "A payment could not be
 * delivered".
 *
 * The abort came from the lib's own bulk sweep (`reconcileWallet`), which took
 * the action for an abandoned `noSend` because our
 * `StorageExpoSQLite.attemptToPostReqsToNetwork` HOLDS token requests rather
 * than posting them, so the lib's journal entry had been cleared as "broadcast"
 * when nothing had been. Three fixes met here — the lib no longer cleared that
 * entry, `reconcileJournals` no longer ran the sweep at all, and this guard
 * makes the abort itself unreachable from any caller, including one we have
 * not thought of.
 *
 * 1Color (plan 07, W1): the decision is now keyed on the wallet's one durable
 * host record, the `color_transfers` journal, looked up by the `createAction`
 * reference that built the tx. The four σI settlement tables are gone (Task 6
 * dropped them with no legacy rows left behind), so the old coarse "any
 * reference-less legacy row in a blocked state" check (XR-033) has nothing to
 * read and is removed. The guard never reads the color module's internal
 * `color.v1.*` keys (IC §2.1: that layout is T2-internal).
 *
 * **The guard is a refusal, not a repair.** It answers `{ aborted: false }`,
 * which is exactly what `abortAction` already returns for an action it will not
 * abort, and every existing caller in this wallet already treats that as a
 * failure to release rather than as a released action (see
 * `finalizeDelivery`'s `queueFailedAbort`). It never throws: a throw from a
 * cleanup path is how a caller ends up abandoning something it was tidying.
 */
import type { TransferJournal } from './transferJournal'
import type { ColorTransferRow, ColorTransferState } from './types'

/**
 * Journal states in which the bytes are, or may already be, somewhere this
 * device cannot recall them from.
 *
 * `handed_over` is in the list whatever `delivered` says (W4). On the handle
 * rail the row moves to `handed_over` BEFORE `deliverHandover` runs, because a
 * lost MessageBox response may still have delivered; on the nearby rail the
 * payee holds the frame. Either way the payee may submit it, and releasing the
 * inputs under a payee who is about to submit is the incident's double spend,
 * only with a longer fuse. `settled` is the overlay's admission, which
 * broadcasts — the incident's own state.
 *
 * Everything else is safe to abort, and deliberately so:
 *  · `built`/`parked` — the payer's own states. The payee has NOT been handed
 *    anything, nothing has been submitted, and cancelling a parked payment is a
 *    feature (`cancelParkedPayment`) that must keep working.
 *  · `refused`/`cancelled` — a final word that the money never moved. The
 *    inputs SHOULD come back.
 *  · `held` is a received-role state; a received row carries no `reference`,
 *    so no abort can ever name it.
 */
export const ABORT_BLOCKED_TRANSFER_STATES: readonly ColorTransferState[] = ['handed_over', 'settled']

export function abortIsBlockedBy(row: ColorTransferRow | undefined): boolean {
  if (!row) return false
  return ABORT_BLOCKED_TRANSFER_STATES.includes(row.state)
}

/** The shape this wrapper needs of a manager. Structural, so a test can pass a plain object. */
export interface AbortableManager {
  abortAction: (args: { reference: string }, originator?: string) => Promise<{ aborted: boolean }>
}

/**
 * Where the journal lives, read LATE.
 *
 * A function rather than a journal, because the wrapper is built once around
 * the published permissions manager while the token runtime is constructed
 * after it — and is replaced wholesale on a network switch or a wallet
 * rebuild. Capturing a journal here would guard the departed wallet's table.
 * Returning `undefined` is NOT "no payment at stake" on its own; see
 * `TokenSettlementPossible`.
 */
export type TransferJournalLookup = () => Pick<TransferJournal, 'getByReference'> | undefined

/**
 * Whether a token payment could exist on THIS wallet build at all — read LATE,
 * for the same reason the journal is, and answering ONLY the question of
 * whether the current chain's configuration could ever have written a
 * `color_transfers` row.
 *
 * XR-034 (SEC1-024 / SEC2-038). `journal()` answering `undefined` is not one
 * fact. It reads `undefined` in situations that mean opposite things for
 * safety:
 *   1. This chain has no Mandala endpoints at all, so no token action has ever
 *      existed here, or ever can.
 *   2. The runtime THREW while endpoints exist, or a network switch/rebuild has
 *      cleared the ref ahead of the new build's runtime replacing it. Either
 *      way the chain's own storage may still carry a `handed_over`/`settled`
 *      row; this call simply cannot see it right now.
 *
 * Only case 1 licenses treating `undefined` as "no row, safe". WalletContext
 * wires this to a static fact of the chain's own configuration that does not
 * fluctuate with runtime construction, build failures, or rebuild timing.
 */
export type TokenSettlementPossible = () => boolean

/**
 * Wrap `abortAction` so an action that built a token transaction the payee or
 * the overlay may already have cannot release its inputs.
 *
 * Same pattern and same placement as the createAction input wrapper: it wraps
 * the RAW permissions manager and `guardVaultAccess` is applied to the RESULT,
 * so the published object is still the one the guard's own re-wrap dedup
 * recognises. Every other method and property passes through untouched.
 *
 * **XR-034: fails CLOSED on anything but a definitive "no".** A database that
 * will not answer, a runtime that has not been built yet, one mid-rebuild, and
 * a lookup that itself throws are all indistinguishable from "a payment is in
 * flight" — they are exactly the moments this device can least tell, which is
 * the opposite of evidence that releasing inputs is safe. Refusing the abort in
 * that window costs a retry (every caller already treats `{ aborted: false }`
 * as "did not release, try again" — see `queueFailedAbort`); wrongly granting
 * it costs a double spend. The one shape that still passes through when
 * `journal()` answers `undefined` is `tokenSettlementPossible()` reporting
 * false: a chain with no Mandala configuration at all, where a blocking row
 * could never have been written and refusing every plain BSV abort forever
 * would be its own outage.
 */
export function wrapAbortActionForSettlements<T extends AbortableManager>(
  manager: T,
  journal: TransferJournalLookup,
  tokenSettlementPossible: TokenSettlementPossible
): T {
  return new Proxy(manager, {
    get(target, prop, receiver) {
      if (prop === 'abortAction') {
        return async (args: { reference: string }, originator?: string) => {
          try {
            const current = journal()
            if (!current) {
              if (tokenSettlementPossible()) {
                console.warn(
                  '[mandala] refusing to abort: the token transfer journal is unavailable right now ' +
                    '(the runtime is not built, is rebuilding, or its database could not be reached) and this ' +
                    'chain can carry token payments — releasing inputs could double spend one the payee or overlay already has'
                )
                return { aborted: false }
              }
              // No Mandala endpoints on this chain: a blocking row could never
              // have been written, so this is a plain BSV abort like any other.
            } else {
              const row = await lookupTransfer(current, args?.reference)
              if (abortIsBlockedBy(row)) {
                console.warn(
                  `[mandala] refusing to abort ${row!.txid}: its token transfer is '${row!.state}', ` +
                    'so releasing these inputs would double spend a transaction the payee or overlay may already have'
                )
                return { aborted: false }
              }
            }
          } catch (e) {
            console.warn("[mandala] refusing to abort: could not read this action's token transfer state:", e)
            return { aborted: false }
          }
          return await target.abortAction(args, originator)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as T
}

async function lookupTransfer(
  journal: Pick<TransferJournal, 'getByReference'>,
  reference: string | undefined
): Promise<ColorTransferRow | undefined> {
  // No reference names no journal row: the underlying abortAction refuses it
  // on its own, and no token action is ever built without one.
  if (!reference) return undefined
  return await journal.getByReference(reference)
}
