/**
 * Recording a merkle proof the wallet fetched itself (Refresh on an activity
 * row). The toolbox path needs a proven_tx_req to hang the proof on, but a
 * payment whose first internalize failed half-way and was then retried down
 * the merge path has a transaction row and an output — and no req (Android
 * DB, 2026-09-02: tx fce9…, status unproven, no proven_tx_req, no proven_tx).
 * Refresh used to throw on that row and the monitor never proves it either.
 */
import { recordProof, type ProofStorage } from '../../core/pay/recordProof'

const TXID = 'fc'.repeat(32)
const PROOF = { index: 3, height: 965078, blockHash: 'ab'.repeat(32), merklePath: [1, 2, 3], merkleRoot: 'cd'.repeat(32) }
const RAW_TX = [0, 1, 0, 0, 0]

function fakeStorage(seed: {
  reqs?: { provenTxReqId: number; status: string; attempts: number; history: string }[]
  txs?: { transactionId: number; status: string }[]
  provens?: { provenTxId: number }[]
}) {
  const calls: { method: string; args: unknown }[] = []
  const storage: ProofStorage = {
    findProvenTxReqs: async () => (seed.reqs ?? []).map(r => ({ ...r, txid: TXID })) as never,
    updateProvenTxReqWithNewProvenTx: async args => {
      calls.push({ method: 'updateProvenTxReqWithNewProvenTx', args })
      return { status: 'completed', history: '' } as never
    },
    findTransactions: async () => (seed.txs ?? []).map(t => ({ ...t, txid: TXID })) as never,
    findProvenTxs: async () => (seed.provens ?? []).map(p => ({ ...p, txid: TXID })) as never,
    insertProvenTx: async tx => {
      calls.push({ method: 'insertProvenTx', args: tx })
      return 77
    },
    updateTransaction: async (id, update) => {
      calls.push({ method: 'updateTransaction', args: { id, update } })
      return 1
    }
  }
  return { storage, calls }
}

describe('recordProof', () => {
  it('goes through the req when one exists, and never fetches the raw tx', async () => {
    const { storage, calls } = fakeStorage({ reqs: [{ provenTxReqId: 9, status: 'unmined', attempts: 2, history: '{}' }] })
    const fetchRawTx = jest.fn()
    const outcome = await recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx })
    expect(outcome).toBe('via-req')
    expect(fetchRawTx).not.toHaveBeenCalled()
    expect(calls).toEqual([
      {
        method: 'updateProvenTxReqWithNewProvenTx',
        args: { provenTxReqId: 9, status: 'unmined', txid: TXID, attempts: 2, history: '{}', ...PROOF }
      }
    ])
  })

  it('with no req, writes the proven tx itself and completes the transaction row', async () => {
    const { storage, calls } = fakeStorage({ txs: [{ transactionId: 1, status: 'unproven' }] })
    const outcome = await recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx: async () => RAW_TX })
    expect(outcome).toBe('direct')
    expect(calls[0].method).toBe('insertProvenTx')
    expect(calls[0].args).toMatchObject({ txid: TXID, rawTx: RAW_TX, ...PROOF })
    expect(calls[1]).toEqual({
      method: 'updateTransaction',
      args: { id: 1, update: { status: 'completed', provenTxId: 77 } }
    })
  })

  it('with no req but an existing proven tx, reuses it instead of inserting a duplicate', async () => {
    const { storage, calls } = fakeStorage({
      txs: [{ transactionId: 1, status: 'unproven' }],
      provens: [{ provenTxId: 5 }]
    })
    const fetchRawTx = jest.fn()
    await recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx })
    expect(fetchRawTx).not.toHaveBeenCalled()
    expect(calls).toEqual([
      { method: 'updateTransaction', args: { id: 1, update: { status: 'completed', provenTxId: 5 } } }
    ])
  })

  it('completes every transaction row that shares the txid', async () => {
    const { storage, calls } = fakeStorage({
      txs: [
        { transactionId: 1, status: 'unproven' },
        { transactionId: 4, status: 'sending' }
      ]
    })
    await recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx: async () => RAW_TX })
    expect(calls.filter(c => c.method === 'updateTransaction').map(c => (c.args as { id: number }).id)).toEqual([1, 4])
  })

  it('leaves an already-completed row alone', async () => {
    const { storage, calls } = fakeStorage({
      txs: [{ transactionId: 1, status: 'completed' }],
      provens: [{ provenTxId: 5 }]
    })
    await recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx: async () => RAW_TX })
    expect(calls).toEqual([])
  })

  it('throws when the wallet has no record of the txid at all', async () => {
    const { storage } = fakeStorage({})
    await expect(recordProof(storage, { txid: TXID, proof: PROOF, fetchRawTx: async () => RAW_TX })).rejects.toThrow(
      /no record/i
    )
  })
})
