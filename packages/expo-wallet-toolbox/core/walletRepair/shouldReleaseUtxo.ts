export type UtxoProbe = { status: 'success' | 'error'; isUtxo?: boolean }

export function shouldReleaseUtxo(args: {
  online: boolean
  txStatus: string
  txid: string
  liveOfflineTxids: Set<string>
  probe: UtxoProbe
}): boolean {
  return (
    args.online &&
    args.txStatus !== 'nosend' &&
    args.txStatus !== 'unproven' &&
    !args.liveOfflineTxids.has(args.txid) &&
    args.probe.status === 'success' &&
    args.probe.isUtxo === false
  )
}
