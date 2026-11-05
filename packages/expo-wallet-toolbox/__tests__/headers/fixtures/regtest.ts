import { utils } from '@bsv/wallet-toolbox-mobile'
import { bitsToTarget, parseHeader } from '../../../core/headers/headerConsensus'

export const genesis = new Uint8Array(utils.genesisBuffer('regtest'))
export const genesisHeader = parseHeader(genesis)
export const anchor = { height: 0, hash: genesisHeader.hash }

export function branch(count: number, salt: string): Uint8Array[] {
  const result: Uint8Array[] = []
  let previous = genesisHeader
  for (let i = 0; i < count; i++) {
    const header = {
      version: 4,
      previousHash: previous.hash,
      merkleRoot: (salt + String(i)).padEnd(64, '0'),
      time: genesisHeader.time + (i + 1) * 600,
      bits: 0x207fffff,
      nonce: 0
    }
    let bytes: Uint8Array
    for (;;) {
      bytes = new Uint8Array(utils.serializeBaseBlockHeader(header))
      if (BigInt(`0x${parseHeader(bytes).hash}`) <= bitsToTarget(header.bits)) break
      header.nonce++
    }
    result.push(bytes)
    previous = parseHeader(bytes)
  }
  return result
}

export function combine(headers: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(headers.length * 80)
  headers.forEach((header, i) => bytes.set(header, i * 80))
  return bytes
}
