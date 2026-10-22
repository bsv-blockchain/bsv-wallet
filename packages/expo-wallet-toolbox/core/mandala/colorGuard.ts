/**
 * The broadcast hold's predicate: which transactions the wallet must not post.
 *
 * IC §8.2 (host broadcast guard): a host holds the toolbox's broadcast of any
 * transaction with a BRC-162 output until that transaction is settled, and a
 * receipt's `internalizeAction` must not reach the network before a verified
 * admission. Plan 07 W1 keys that on the wallet's own journal,
 * `color_transfers`, and never on the module's `color.v1.*` keys (IC §2.1 says
 * that layout is module-internal).
 *
 * The rule, and why each arm fails closed:
 *  - A tx with a 1Color output is held unless its journal row reads `settled`.
 *    A missing row holds. That is the case this guard exists for: the module
 *    credited a receipt as `color_offline` because the Mandala overlay was
 *    unreachable, but ARC was reachable, so `internalizeAction`'s forced
 *    broadcast would post a token tx nothing has admitted (the 2026-09-15
 *    incident shape, Review Focus 1).
 *  - Bytes that will not parse cannot be shown to be plain BSV, so they count
 *    as 1Color. A req with no bytes at all is held for the same reason.
 *  - A journal read fault propagates. Every caller already turns a throw into
 *    "hold the whole batch" or "stall this step"; answering an empty set here
 *    would read as "nothing to hold" and post.
 *
 * Plain BSV never touches the journal: a batch with no 1Color tx is answered
 * from the bytes alone.
 */
import { Transaction, type LockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { decodeToken } from '@bsv/mandala/brc162'
import type { TransferJournal } from './transferJournal'

/**
 * True when any output of `rawTx` is a BRC-162 1Color output, and when the
 * bytes cannot be parsed at all (fail closed).
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
 * held ⇔ `txHasColorOutput(rawTx)` ∧ journal state ≠ `settled`, and a req
 * with no `rawTx` is held whatever the journal says (its bytes cannot be
 * shown to be anything, and there is nothing to post anyway). One `statesOf`
 * read covers the batch. Journal faults propagate.
 */
export async function colorHeldTxids(
  reqs: readonly { txid: string; rawTx?: readonly number[] | Uint8Array }[],
  journal: Pick<TransferJournal, 'statesOf'>
): Promise<Set<string>> {
  const held = new Set<string>()
  const color = new Set<string>()
  for (const r of reqs) {
    if (r.rawTx == null) held.add(r.txid)
    else if (txHasColorOutput(r.rawTx)) color.add(r.txid)
  }
  for (const txid of held) color.delete(txid)
  if (color.size === 0) return held
  const states = await journal.statesOf([...color])
  for (const txid of color) if (states.get(txid) !== 'settled') held.add(txid)
  return held
}
