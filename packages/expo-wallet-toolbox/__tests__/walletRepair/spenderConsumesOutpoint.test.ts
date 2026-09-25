import { spenderConsumesOutpoint } from '../../core/walletRepair/spenderConsumesOutpoint'

const OUTPOINT = { txid: 'aa'.repeat(32), vout: 0 }
const SPENDER_TXID = 'bb'.repeat(32)

describe('XR-031: spenderConsumesOutpoint', () => {
  it('confirms when the parsed spender hashes to the claimed txid and references the outpoint', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: SPENDER_TXID,
        expectedTxid: SPENDER_TXID,
        inputs: [{ sourceTXID: OUTPOINT.txid, sourceOutputIndex: OUTPOINT.vout }],
        outpoint: OUTPOINT
      })
    ).toBe(true)
  })

  it('falls back to sourceTransaction.id() when sourceTXID is absent', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: SPENDER_TXID,
        expectedTxid: SPENDER_TXID,
        inputs: [{ sourceOutputIndex: OUTPOINT.vout, sourceTransaction: { id: () => OUTPOINT.txid } }],
        outpoint: OUTPOINT
      })
    ).toBe(true)
  })

  it('rejects when the parsed BEEF hashes to a different transaction than the chain services claimed', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: 'cc'.repeat(32),
        expectedTxid: SPENDER_TXID,
        inputs: [{ sourceTXID: OUTPOINT.txid, sourceOutputIndex: OUTPOINT.vout }],
        outpoint: OUTPOINT
      })
    ).toBe(false)
  })

  it('rejects when none of the spender inputs reference this outpoint', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: SPENDER_TXID,
        expectedTxid: SPENDER_TXID,
        inputs: [{ sourceTXID: 'dd'.repeat(32), sourceOutputIndex: 1 }],
        outpoint: OUTPOINT
      })
    ).toBe(false)
  })

  it('rejects on the right vout but the wrong txid', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: SPENDER_TXID,
        expectedTxid: SPENDER_TXID,
        inputs: [{ sourceTXID: 'dd'.repeat(32), sourceOutputIndex: OUTPOINT.vout }],
        outpoint: OUTPOINT
      })
    ).toBe(false)
  })

  it('rejects an empty input list', () => {
    expect(
      spenderConsumesOutpoint({
        parsedTxid: SPENDER_TXID,
        expectedTxid: SPENDER_TXID,
        inputs: [],
        outpoint: OUTPOINT
      })
    ).toBe(false)
  })
})
