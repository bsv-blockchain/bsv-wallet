/**
 * Cancel a parked nearby payment: one that was built, shown as a QR code, and
 * deliberately never released for broadcast.
 *
 * Parked is the honest state after the payer leaves the code screen without
 * confirming the hand-over: we cannot see whether the other phone scanned the
 * frame, so the transaction stays `nosend` and its inputs stay reserved. This
 * is the exit from that state for the "they never got it" case — abort the
 * action so the coins come back, and retire the offline row.
 *
 * Refuses once the transaction has left `nosend`. If it has been promoted, the
 * counterparty did broadcast (or is about to), and releasing the inputs would
 * hand the payer a double-spend against the person they just paid.
 */

import { updateOfflineAction } from '../storage/methods/offlineActions'

const CANCELLABLE = new Set(['nosend', 'unsigned', 'unprocessed'])

export type CancelParkedOutcome = 'cancelled' | 'already-sent' | 'not-found'

export interface CancelParkedStorage {
  readonly sqliteDb: unknown
  findTransactions(args: {
    partial: { txid: string }
    noRawTx?: boolean
  }): Promise<{ reference?: string; status?: string }[]>
}

export interface CancelParkedWallet {
  abortAction(args: { reference: string }, originator?: string): Promise<{ aborted?: boolean } | void>
}

export async function cancelParkedPayment(args: {
  storage: CancelParkedStorage
  wallet: CancelParkedWallet
  originator?: string
  txid: string
}): Promise<CancelParkedOutcome> {
  const { storage, wallet, originator, txid } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot cancel this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) return 'not-found'
  if (!tx.status || !CANCELLABLE.has(tx.status)) return 'already-sent'
  if (!tx.reference) return 'not-found'

  const r = await wallet.abortAction({ reference: tx.reference }, originator)
  if (r && r.aborted === false) throw new Error('the wallet refused to cancel this payment')

  // Only after the abort landed: a retained parked row is recoverable, a
  // retired row over a live reservation is not.
  await updateOfflineAction(db as never, txid, { status: 'acknowledged' })
  return 'cancelled'
}
