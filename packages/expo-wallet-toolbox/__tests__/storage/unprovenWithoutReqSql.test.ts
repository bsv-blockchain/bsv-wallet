/**
 * Transactions the monitor can never prove: status unproven, no proven_tx_req
 * to fetch a proof through, no proven_tx already recorded. The shape a
 * half-written internalize leaves behind once the merge-path retry adds the
 * output but not the req (Android DB, 2026-09-02).
 */
import { DatabaseSync } from 'node:sqlite'
import { UNPROVEN_TXIDS_WITHOUT_REQ_SQL, findUnprovenTxidsWithoutReq } from '../../core/storage/methods/unprovenWithoutReqSql'

const TX1 = 'aa'.repeat(32)
const TX2 = 'bb'.repeat(32)
const TX3 = 'cc'.repeat(32)
const TX4 = 'dd'.repeat(32)

function seeded(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT, status TEXT, provenTxId INTEGER);
    CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, status TEXT);
    CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT);
  `)
  // 1: stuck — unproven, nothing to prove it through.
  d.prepare('INSERT INTO transactions VALUES (1, ?, ?, NULL)').run(TX1, 'unproven')
  // 2: unproven but has a req: the monitor's job, not ours.
  d.prepare('INSERT INTO transactions VALUES (2, ?, ?, NULL)').run(TX2, 'unproven')
  d.prepare('INSERT INTO proven_tx_reqs VALUES (1, ?, ?)').run(TX2, 'unmined')
  // 3: unproven with no req, but a proven_tx already exists: not stuck.
  d.prepare('INSERT INTO transactions VALUES (3, ?, ?, NULL)').run(TX3, 'unproven')
  d.prepare('INSERT INTO proven_txs VALUES (1, ?)').run(TX3)
  // 4: no req either, but completed.
  d.prepare('INSERT INTO transactions VALUES (4, ?, ?, 1)').run(TX4, 'completed')
  return d
}

const adapt = (d: DatabaseSync) => ({
  getAllAsync: async (sql: string, params: unknown[] = []) => d.prepare(sql).all(...(params as never[]))
})

describe('findUnprovenTxidsWithoutReq', () => {
  it('returns only the unproven txids with neither a req nor a proven tx', async () => {
    const txids = await findUnprovenTxidsWithoutReq(adapt(seeded()))
    expect(txids).toEqual([TX1])
  })

  it('reports a txid once even when several transaction rows share it', async () => {
    const d = seeded()
    d.prepare('INSERT INTO transactions VALUES (5, ?, ?, NULL)').run(TX1, 'unproven')
    expect(await findUnprovenTxidsWithoutReq(adapt(d))).toEqual([TX1])
  })

  it('is a single statement with no parameters', () => {
    expect(UNPROVEN_TXIDS_WITHOUT_REQ_SQL).not.toMatch(/\?/)
  })
})
