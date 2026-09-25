export type ParsedSpenderInput = {
  sourceTXID?: string
  sourceOutputIndex?: number
  sourceTransaction?: { id(enc: 'hex'): string }
}

/**
 * XR-031: neither the WhatsOnChain "spent" probe nor the toolbox's
 * second-source `getUtxoStatus` corroboration ever look at the alleged
 * spending transaction itself — they are both bare claims. Before Wallet
 * Check commits `spendable:false` against a UTXO, require the claimed
 * spender's own parsed BEEF to (a) actually hash to the txid the chain
 * services named, and (b) contain an input that references the exact
 * outpoint being marked spent. A BEEF that fails to fetch/parse, hashes to a
 * different tx, or doesn't reference this outpoint is not proof of spend —
 * the caller must leave the output spendable rather than mutate it.
 */
export function spenderConsumesOutpoint(args: {
  parsedTxid: string
  expectedTxid: string
  inputs: ParsedSpenderInput[]
  outpoint: { txid: string; vout: number }
}): boolean {
  if (args.parsedTxid !== args.expectedTxid) return false
  return args.inputs.some(input => {
    const inTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    return inTxid === args.outpoint.txid && input.sourceOutputIndex === args.outpoint.vout
  })
}
