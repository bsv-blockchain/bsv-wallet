/**
 * Guard #4: a settled token payment's action may not be aborted.
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
 * when nothing had been. Three fixes meet here — the lib no longer clears that
 * entry, `reconcileJournals` no longer runs the sweep at all, and this guard
 * makes the abort itself unreachable from any caller, including one we have
 * not thought of.
 *
 * **The guard is a refusal, not a repair.** It answers `{ aborted: false }`,
 * which is exactly what `abortAction` already returns for an action it will not
 * abort, and every existing caller in this wallet already treats that as a
 * failure to release rather than as a released action (see
 * `finalizeDelivery`'s `queueFailedAbort`). It never throws: a throw from a
 * cleanup path is how a caller ends up abandoning something it was tidying.
 */
import type { SettlementStore, TokenSettlementRow, TokenSettlementState } from './types'

/**
 * States in which the bytes are, or may already be, somewhere this device
 * cannot recall them from.
 *
 * `handed_over`/`held` are in the list even though nothing has been submitted
 * yet: the PAYEE holds the frame, and either party may submit it (offline
 * settlement §0.1 — "whoever reconnects first submits"). Releasing the inputs
 * under a payee who is about to submit is the same double spend, only with a
 * longer fuse. `submitting` is a request in flight whose verdict is unknown,
 * and an unknown verdict may be an admission.
 *
 * Everything else is safe to abort, and deliberately so:
 *  · `built`/`parked` — the payer's own states (FIX F). The payee has NOT been
 *    handed anything, nothing has been submitted, and cancelling a parked
 *    payment is a feature (`cancelParkedPayment`) that must keep working.
 *  · `refused`/`orphaned` — the overlay's final word. The money never moved and
 *    the inputs SHOULD come back.
 */
export const ABORT_BLOCKED_SETTLEMENT_STATES: readonly TokenSettlementState[] = [
  'held',
  'handed_over',
  'submitting',
  'admitted',
  'broadcast'
]

export function abortIsBlockedBy(row: TokenSettlementRow | undefined): boolean {
  if (!row) return false
  return ABORT_BLOCKED_SETTLEMENT_STATES.includes(row.state)
}

/** The shape this wrapper needs of a manager. Structural, so a test can pass a plain object. */
export interface AbortableManager {
  abortAction: (args: { reference: string }, originator?: string) => Promise<{ aborted: boolean }>
}

/**
 * Where the settlement rows live, read LATE.
 *
 * A function rather than a store, because the wrapper is built once around the
 * published permissions manager while the Mandala runtime is constructed after
 * it — and is replaced wholesale on a network switch or a wallet rebuild.
 * Capturing a store here would guard the departed wallet's tables. Returning
 * `undefined` (no runtime, no database, not a Mandala chain) means "no token
 * payment can be at stake", which is the correct answer, not a failure.
 */
export type SettlementStoreLookup = () => Pick<SettlementStore, 'getSettlementByReference'> | undefined

/**
 * Wrap `abortAction` so an action that built a token transaction the overlay
 * may already have cannot release its inputs.
 *
 * Same pattern and same placement as `wrapCreateActionForTokenInputs`: it wraps
 * the RAW permissions manager and `guardVaultAccess` is applied to the RESULT,
 * so the published object is still the one the guard's own re-wrap dedup
 * recognises. Every other method and property passes through untouched.
 *
 * **Fails OPEN on a lookup fault.** A database that will not answer is not
 * evidence that a payment is in flight, and refusing every abort in the wallet
 * because one read threw would strand inputs across the whole app — including
 * for plain BSV payments this guard has no business touching. The read is
 * cheap, indexed, and asked only of `abortAction`.
 */
export function wrapAbortActionForSettlements<T extends AbortableManager>(
  manager: T,
  settlements: SettlementStoreLookup
): T {
  return new Proxy(manager, {
    get(target, prop, receiver) {
      if (prop === 'abortAction') {
        return async (args: { reference: string }, originator?: string) => {
          const row = await lookupSettlement(settlements, args?.reference)
          if (abortIsBlockedBy(row)) {
            console.warn(
              `[mandala] refusing to abort ${row!.txid}: its settlement is '${row!.state}', ` +
                'so releasing these inputs would double spend a transaction the overlay may already have'
            )
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

async function lookupSettlement(
  settlements: SettlementStoreLookup,
  reference: string | undefined
): Promise<TokenSettlementRow | undefined> {
  if (!reference) return undefined
  try {
    return await settlements()?.getSettlementByReference(reference)
  } catch (e) {
    console.warn('[mandala] could not check the settlement of an aborted action; allowing the abort:', e)
    return undefined
  }
}
