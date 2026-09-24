export type SecondSourceProbe = { status: 'success' | 'error'; isUtxo?: boolean }

/**
 * A single WoC "spent" endpoint 200-with-txid response is not enough to
 * permanently mark a UTXO unspendable (misc-p2-01) — WoC can be wrong,
 * stale, or answering for the wrong network, and checkUtxoSpendability never
 * writes `spentBy`, so nothing can ever restore a wrong call. Require a
 * second, independent source (the toolbox's own configured getUtxoStatus
 * providers) to also report the output as no longer a UTXO before committing
 * to spendable:false.
 */
export function shouldMarkUnspendable(args: {
  wocProbe: SecondSourceProbe
  wocSpendingTxid: string | undefined
  utxoStatus: SecondSourceProbe
}): boolean {
  if (args.wocProbe.status !== 'success' || args.wocProbe.isUtxo !== false) return false
  if (!args.wocSpendingTxid) return false
  return args.utxoStatus.status === 'success' && args.utxoStatus.isUtxo === false
}
