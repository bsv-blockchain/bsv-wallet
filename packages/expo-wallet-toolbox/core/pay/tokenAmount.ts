import { Transaction, type AtomicBEEF } from '@bsv/sdk'

export function satoshisFromToken(token: {
  transaction: AtomicBEEF
  outputIndex?: number
  amount?: number
}): { satoshis: number; claimedAgrees: boolean } | undefined {
  try {
    const tx = Transaction.fromAtomicBEEF(token.transaction)
    const satoshis = tx.outputs[token.outputIndex ?? 0]?.satoshis
    if (typeof satoshis !== 'number' || satoshis < 0) return undefined
    const claimed = token.amount
    const claimedAgrees = typeof claimed !== 'number' || !Number.isFinite(claimed) || claimed === satoshis
    return { satoshis, claimedAgrees }
  } catch {
    return undefined
  }
}
