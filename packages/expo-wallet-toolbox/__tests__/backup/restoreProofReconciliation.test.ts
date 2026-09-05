import { PrivateKey } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { encodeChunk, emptyChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { restoreOnImport } from '../../core/backup/restoreOnImport'

// Exercise real SQLite SQL plus the installed toolbox's merge and proof
// completion methods; only the native connection is replaced for Jest.
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) { this.db.exec(sql) }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...params)
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) { return this.db.prepare(sql).get(...params) ?? null }
    async getAllAsync(sql: string, params: unknown[] = []) { return this.db.prepare(sql).all(...params) }
    async withExclusiveTransactionAsync(fn: (transaction: TestDatabase) => Promise<void>) {
      this.db.exec('BEGIN')
      try {
        await fn(this)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    async closeAsync() { this.db.close() }
  }
  return { openDatabaseAsync: async () => new TestDatabase() }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

const PRIMARY = new PrivateKey(21).toArray('be', 32)
const IDENTITY = new PrivateKey(PRIMARY).toPublicKey().toString()
const DEVICE = 'd'.repeat(32)
const TXID = 'a'.repeat(64)
const START = new Date('2026-09-01T00:00:00Z')
const LATER = new Date('2026-09-02T00:00:00Z')
const timestamps = { created_at: START, updated_at: START }

function request(txid = TXID, id = 21): any {
  return {
    ...timestamps, provenTxReqId: id, txid, status: 'unsent', attempts: 0,
    history: JSON.stringify({ notes: [] }), notify: JSON.stringify({ transactionIds: [31] }),
    rawTx: [1], inputBEEF: [2], notified: false
  }
}

function pendingChunk(): SyncChunk {
  const chunk = emptyChunk(DEVICE, 'backup', IDENTITY)
  chunk.provenTxReqs = [request()]
  chunk.transactions = [{
    ...timestamps, transactionId: 31, userId: 99, txid: TXID, status: 'sending',
    reference: 'restore-regression', isOutgoing: true, satoshis: -10, description: 'test',
    version: 1, lockTime: 0, rawTx: [1], inputBEEF: [2]
  }]
  return chunk
}

function completedChunk(): SyncChunk {
  const chunk = pendingChunk()
  chunk.provenTxs = [{
    ...timestamps, updated_at: LATER, provenTxId: 41, txid: TXID, rawTx: [1],
    height: 100, index: 0, merklePath: [0], blockHash: 'b'.repeat(64), merkleRoot: TXID
  }]
  chunk.transactions![0] = { ...chunk.transactions![0], updated_at: LATER, status: 'completed', provenTxId: 41 }
  chunk.provenTxReqs![0] = { ...request(), updated_at: LATER, status: 'completed', provenTxId: 41, notified: true }
  return chunk
}

let storage: StorageExpoSQLite
beforeEach(async () => {
  storage = new StorageExpoSQLite({ chain: 'main', identityKey: IDENTITY, databaseName: 'restore-test' } as any)
  await storage.migrate('test', IDENTITY)
})
afterEach(async () => {
  jest.restoreAllMocks()
  await storage.destroy()
})

async function clientFor(chunks: SyncChunk[]): Promise<any> {
  const wallet = deriveBackupWallet(PRIMARY, 'main')
  const blobs = await Promise.all(chunks.map(chunk => encodeChunk(wallet, chunk, 'main')))
  return {
    manifest: jest.fn().mockResolvedValue([{
      deviceId: DEVICE, generation: 1, headSeq: blobs.length, updatedAt: LATER.toISOString()
    }]),
    index: jest.fn().mockResolvedValue(blobs.map((blob, i) => ({
      seq: i + 1, size: blob.length, sha256: `sha${i + 1}`, prevSha256: i ? `sha${i}` : undefined,
      createdAt: LATER.toISOString()
    }))),
    blob: jest.fn(async (_device, _generation, seq) => new Uint8Array(blobs[seq - 1]))
  }
}

function restore(client: any, validateRestoredCoins?: () => Promise<void>) {
  return restoreOnImport({ storage, client, primaryKey: PRIMARY, identityKey: IDENTITY, chain: 'main', validateRestoredCoins })
}

it('reconciles an unsent request after a later completed chunk, using the mapped existing proof', async () => {
  const original = storage.updateProvenTxReqWithNewProvenTx.bind(storage)
  const complete = jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx').mockImplementation(async args => {
    // The real toolbox merge currently leaves this request unsent even though
    // its transaction was completed by the later chunk.
    const [requestBefore] = await storage.findProvenTxReqs({ partial: { txid: TXID } })
    const [transactionBefore] = await storage.findTransactions({ partial: { txid: TXID } })
    expect(requestBefore.status).toBe('unsent')
    expect(transactionBefore.status).toBe('completed')
    return original(args)
  })
  const validate = jest.fn(async () => {
    const [req] = await storage.findProvenTxReqs({ partial: { txid: TXID } })
    expect(req.status).toBe('completed')
    expect(req.notified).toBe(true)
  })

  expect((await restore(await clientFor([pendingChunk(), completedChunk()]), validate)).restored).toBe(true)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(validate).toHaveBeenCalledTimes(1)
  const [req] = await storage.findProvenTxReqs({ partial: { txid: TXID } })
  const [tx] = await storage.findTransactions({ partial: { txid: TXID } })
  const proofs = await storage.findProvenTxs({ partial: { txid: TXID } })
  expect(proofs).toHaveLength(1)
  expect(req.provenTxId).toBe(proofs[0].provenTxId)
  expect(tx.provenTxId).toBe(proofs[0].provenTxId)
  expect(JSON.parse(req.notify).transactionIds).toEqual([tx.transactionId])
  // Keep the storage's terminal-status guard fully intact.
  await expect(storage.updateTransactionStatus('unproven', tx.transactionId)).rejects.toThrow(/completed/)
})

it('leaves unproven requests without an existing proof unchanged across request pages', async () => {
  const chunk = emptyChunk(DEVICE, 'backup', IDENTITY)
  chunk.provenTxReqs = Array.from({ length: 26 }, (_, i) => ({
    ...request(i.toString(16).padStart(64, '0'), i + 1), notify: '{}'
  }))
  const complete = jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx')
  await restore(await clientFor([chunk]))
  const requests = await storage.findProvenTxReqs({ partial: {} })
  expect(requests).toHaveLength(26)
  expect(requests.every(req => req.status === 'unsent')).toBe(true)
  expect(complete).not.toHaveBeenCalled()
})

it('does not rewrite an existing completed request when a later replay leaves its notification intact', async () => {
  await restore(await clientFor([completedChunk()]))
  const complete = jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx')
  const unrelated = emptyChunk(DEVICE, 'backup', IDENTITY)
  unrelated.provenTxReqs = [{ ...request('c'.repeat(64), 22), notify: '{}' }]
  await restore(await clientFor([unrelated]))
  expect(complete).not.toHaveBeenCalled()
})

it('fails before coin validation on reconciliation errors and allows an idempotent retry', async () => {
  const complete = jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx')
    .mockRejectedValueOnce(new Error('proof write failed'))
  const validate = jest.fn(async () => {})
  const client = await clientFor([pendingChunk(), completedChunk()])
  await expect(restore(client, validate)).rejects.toThrow('proof write failed')
  expect(validate).not.toHaveBeenCalled()
  expect((await restore(client, validate)).restored).toBe(true)
  expect(complete).toHaveBeenCalledTimes(2)
  expect(validate).toHaveBeenCalledTimes(1)
})

it('fails the restore when the canonical completion reports incomplete notification', async () => {
  jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx').mockResolvedValue({
    status: 'completed', provenTxId: 1, history: '{}', notified: false
  })
  const validate = jest.fn(async () => {})
  await expect(restore(await clientFor([pendingChunk(), completedChunk()]), validate))
    .rejects.toThrow(/reconciliation did not complete/)
  expect(validate).not.toHaveBeenCalled()
})


it('does not skip the next request when reconciliation completes an earlier page', async () => {
  const pending = pendingChunk()
  const completed = completedChunk()
  const secondTxid = 'd'.repeat(64)
  pending.transactions!.push({ ...pending.transactions![0], transactionId: 32, txid: secondTxid, reference: 'second' })
  pending.provenTxReqs!.push({ ...request(secondTxid, 22), notify: JSON.stringify({ transactionIds: [32] }) })
  completed.transactions!.push({ ...completed.transactions![0], transactionId: 32, txid: secondTxid, reference: 'second', provenTxId: 42 })
  completed.provenTxs!.push({ ...completed.provenTxs![0], provenTxId: 42, txid: secondTxid })
  completed.provenTxReqs!.push({
    ...completed.provenTxReqs![0], provenTxReqId: 22, txid: secondTxid, provenTxId: 42,
    notify: JSON.stringify({ transactionIds: [32] })
  })
  const complete = jest.spyOn(storage, 'updateProvenTxReqWithNewProvenTx')
  await restore(await clientFor([pending, completed]))
  expect(complete).toHaveBeenCalledTimes(2)
  const requests = await storage.findProvenTxReqs({ partial: {} })
  expect(requests.map(req => req.status)).toEqual(['completed', 'completed'])
  expect(requests.every(req => req.notified)).toBe(true)
})
