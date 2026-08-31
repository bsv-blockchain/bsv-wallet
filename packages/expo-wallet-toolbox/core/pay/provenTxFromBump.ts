/**
 * Proven-tx write payload from a BUMP and the header hash that backs it.
 * `headerHash` must be a real block hash — never persist `''`.
 */
export function provenTxFromBump(args: {
  merklePath: {
    blockHeight: number
    path: Array<Array<{ txid?: boolean; hash?: string; offset: number }>>
    computeRoot: (txid: string) => string
    toBinary: () => number[]
  }
  txid: string
  headerHash: string
}): {
  index: number
  height: number
  blockHash: string
  merklePath: number[]
  merkleRoot: string
} {
  if (!args.headerHash) throw new Error('blockHash required')
  const leaf = args.merklePath.path[0]?.find(l => l.txid === true && l.hash === args.txid)
  if (!leaf) throw new Error('txid not found in BUMP path')
  return {
    index: leaf.offset,
    height: args.merklePath.blockHeight,
    blockHash: args.headerHash,
    merklePath: args.merklePath.toBinary(),
    merkleRoot: args.merklePath.computeRoot(args.txid)
  }
}
