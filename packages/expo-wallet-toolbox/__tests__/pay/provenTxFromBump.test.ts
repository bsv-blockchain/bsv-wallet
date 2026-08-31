import { provenTxFromBump } from '../../core/pay/provenTxFromBump'

const TXID = 'deadbeef'.repeat(8)
const ROOT = 'aa'.repeat(32)
const HASH = 'bb'.repeat(32)

function bump(overrides: Partial<{ offset: number; hash: string; txid: boolean }> = {}) {
  return {
    blockHeight: 100,
    path: [[{ txid: overrides.txid ?? true, hash: overrides.hash ?? TXID, offset: overrides.offset ?? 3 }]],
    computeRoot: () => ROOT,
    toBinary: () => [1, 2, 3]
  }
}

describe('provenTxFromBump', () => {
  it('forwards headerHash as blockHash', () => {
    expect(provenTxFromBump({ merklePath: bump(), txid: TXID, headerHash: HASH }).blockHash).toBe(HASH)
  })

  it('rejects an empty headerHash rather than storing it', () => {
    expect(() => provenTxFromBump({ merklePath: bump(), txid: TXID, headerHash: '' })).toThrow(/blockHash required/)
  })
})
