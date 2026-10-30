/**
 * The broadcast hold's predicate: which transactions the wallet must not post.
 *
 * IC §8.2 (host broadcast guard): a host holds the toolbox's broadcast of a
 * 1Color transaction until it is settled, and a receipt's `internalizeAction`
 * must not reach the network before a verified admission. Plan 07 W1 keys
 * "settled" on the wallet's own journal, `color_transfers`, and never on the
 * module's `color.v1.*` keys (IC §2.1 says that layout is module-internal).
 *
 * The hold applies only where THIS wallet's token custody is involved. A
 * 1Color output alone proves nothing: anyone can add a 1-sat 1Color output to
 * a payment, and a payer who could make the payee's wallet hold a BSV credit
 * (instead of broadcasting it) would keep the payment unconfirmed while
 * staying free to double-spend its inputs (the decoy-output finding, every
 * rail: handle/MessageBox, direct, nearby, address). So a 1Color tx is held
 * when any of these says the wallet's custody is in it:
 *  - a `color_transfers` row (this wallet built or received it as a token
 *    transfer);
 *  - a Mandala host-ledger record (B7: written BEFORE the receipt is
 *    internalized by the lib's receive path and by the issuer-v1 handler's
 *    own admission, and before `sendHandover` returns). The toolbox
 *    broadcasts inside `internalizeAction` BEFORE it stores the receipt's
 *    outputs in their `p color` basket, so the basket cannot be read at hold
 *    time; the ledger can;
 *  - an input it spends from one of this wallet's `p color` baskets (marked
 *    spent before any broadcast attempt, both by `createAction` and by
 *    `internalizeAction`): a token send from any originator.
 * Such a tx is held unless its journal row reads `settled`.
 *
 * Every other arm fails closed:
 *  - Bytes that will not parse cannot be shown to be anything; they are
 *    held. A req with no bytes at all is held for the same reason.
 *  - A journal, ledger or input read fault propagates. Every caller already
 *    turns a throw into "hold the whole batch" or "stall this step";
 *    answering an empty set here would read as "nothing to hold" and post.
 *
 * Plain BSV never touches the journal: a batch with no 1Color tx is answered
 * from the bytes alone.
 */
import { Transaction, type LockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { decodeToken } from '@bsv/mandala/brc162'
import type { TransferJournal } from './transferJournal'

/**
 * What the hold reads besides the bytes. `custodyOf` answers, for txids that
 * have no journal row, which ones this wallet's custody is involved in
 * through the host ledger or its own `p color` inputs. Without it, every
 * 1Color tx counts as custodial (the pre-scoping rule: hold all).
 */
export interface ColorCustody extends Pick<TransferJournal, 'statesOf'> {
  custodyOf?: (txids: readonly string[]) => Promise<ReadonlySet<string>>
}

/**
 * The key prefix of `@bsv/mandala`'s host-ledger records (`hostLedger.ts`,
 * `mandala.host.v1.record.<txid>`). Read raw by the hold: a record that is
 * present but unreadable still counts as custody (fail closed), where the
 * lib's own `get` would read it as absent.
 */
export const HOST_LEDGER_RECORD_PREFIX = 'mandala.host.v1.record.'

/**
 * Of `txids`, the ones whose transaction spends an output of this wallet's
 * `p color` baskets, by SQL over the toolbox's own tables (`outputs.spentBy`
 * is set before any broadcast attempt). Chunked under SQLite's bound-parameter
 * limit. Faults propagate.
 */
export async function txidsSpendingColorOutputs(
  db: { getAllAsync(sql: string, params: (string | number | null)[]): Promise<unknown[]> },
  txids: readonly string[]
): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < txids.length; i += 500) {
    const chunk = txids.slice(i, i + 500)
    const rows = await db.getAllAsync(
      `SELECT DISTINCT t.txid AS txid FROM transactions t
         JOIN outputs o ON o.spentBy = t.transactionId
         JOIN output_baskets b ON b.basketId = o.basketId
        WHERE b.name LIKE 'p color %' AND t.txid IN (${chunk.map(() => '?').join(',')})`,
      chunk
    )
    for (const r of rows as { txid?: unknown }[]) if (typeof r.txid === 'string') out.add(r.txid)
  }
  return out
}

/**
 * True when any output of `rawTx` is a BRC-162 1Color output, and when the
 * bytes cannot be parsed at all (fail closed). A precondition of the hold,
 * never the hold itself (see `colorHeldTxids`).
 *
 * `decodeToken` (the lib's codec boundary) recognises a 1Color output locked
 * to a P2PKH remainder, which is every output a Mandala holder builds. A
 * 1Color envelope over any other remainder is still a BRC-162 token output
 * (0162 lockRemainder), so it is held too: `OneColor.decode` accepting the
 * script is enough.
 */
export function txHasColorOutput(rawTx: readonly number[] | Uint8Array): boolean {
  let tx: Transaction
  try {
    tx = Transaction.fromBinary(Array.from(rawTx))
  } catch {
    return true
  }
  return transactionHasColorOutput(tx)
}

/**
 * The same predicate over an already-parsed transaction: true when any output
 * is a 1Color output by the rule above.
 *
 * Shared by the hold and by `processOfflineActions`, so the two cannot drift
 * on what a 1Color output is.
 */
export function transactionHasColorOutput(tx: Pick<Transaction, 'outputs'>): boolean {
  return tx.outputs.some(o => isColorScript(o.lockingScript))
}

function isColorScript(script: LockingScript | undefined): boolean {
  if (script == null) return false
  if (decodeToken(script) !== null) return true
  try {
    OneColor.decode(script)
    return true
  } catch {
    return false
  }
}

/**
 * Of `reqs`, the txids the toolbox must not broadcast now.
 *
 * held ⇔ no bytes ∨ unparseable bytes ∨ (a 1Color output ∧ custody ∧ journal
 * state ≠ `settled`), where custody is a journal row, or `custodyOf` naming
 * the txid (host ledger, own `p color` inputs). One `statesOf` read and at
 * most one `custodyOf` read cover the batch. Faults propagate.
 */
export async function colorHeldTxids(
  reqs: readonly { txid: string; rawTx?: readonly number[] | Uint8Array }[],
  custody: ColorCustody
): Promise<Set<string>> {
  const held = new Set<string>()
  const color = new Set<string>()
  for (const r of reqs) {
    if (r.rawTx == null) {
      held.add(r.txid)
      continue
    }
    let tx: Transaction
    try {
      tx = Transaction.fromBinary(Array.from(r.rawTx))
    } catch {
      held.add(r.txid)
      continue
    }
    if (transactionHasColorOutput(tx)) color.add(r.txid)
  }
  for (const txid of held) color.delete(txid)
  if (color.size === 0) return held
  const states = await custody.statesOf([...color])
  const unjournaled = [...color].filter(txid => !states.has(txid))
  const custodial =
    unjournaled.length === 0
      ? new Set<string>()
      : custody.custodyOf
        ? await custody.custodyOf(unjournaled)
        : new Set(unjournaled)
  for (const txid of color) {
    const state = states.get(txid)
    if (state !== undefined) {
      if (state !== 'settled') held.add(txid)
    } else if (custodial.has(txid)) {
      held.add(txid)
    }
  }
  return held
}
