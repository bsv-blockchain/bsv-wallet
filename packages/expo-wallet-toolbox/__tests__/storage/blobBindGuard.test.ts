/**
 * Byte columns take bytes or nothing.
 *
 * expo-sqlite binds only a `Uint8Array` as a BLOB; anything else reaches the
 * native layer as a primitive, which Android stringifies into TEXT and iOS
 * refuses (the 2026-09-16 `token_linkage_payloads` incident, whose payload was
 * a JSON-rehydrated `Uint8Array` — an index-keyed plain object). The generic
 * insert/update validators only converted a real `number[]`, so the same value
 * aimed at `rawTx`, `merklePath`, `inputBEEF` or `lockingScript` would have
 * been written in the wrong storage class with no error. These run against the
 * real schema and the real validators.
 */
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) {
      this.db.exec(sql)
    }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...params)
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).get(...params) ?? null
    }
    async getAllAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).all(...params)
    }
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
    async closeAsync() {
      this.db.close()
    }
  }
  return { openDatabaseAsync: async () => new TestDatabase() }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

import { PrivateKey } from '@bsv/sdk'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

const NOW = new Date('2026-09-16T12:00:00Z')
const IDENTITY = new PrivateKey(7).toPublicKey().toString()
const TXID = 'cd'.repeat(32)

let storage: StorageExpoSQLite

beforeEach(async () => {
  storage = new StorageExpoSQLite({ chain: 'main', identityKey: IDENTITY, databaseName: 'blob-guard-test' } as never)
  await storage.migrate('test', IDENTITY)
})

afterEach(async () => {
  await storage.destroy()
})

const provenTx = (rawTx: unknown, merklePath: unknown = [7, 8]) =>
  ({
    created_at: NOW,
    updated_at: NOW,
    provenTxId: 0,
    txid: TXID,
    height: 1,
    index: 0,
    merklePath,
    rawTx,
    blockHash: 'bb'.repeat(32),
    merkleRoot: 'cc'.repeat(32)
  }) as never

async function storageClass(table: string, column: string): Promise<string | undefined> {
  const row = (await storage.sqliteDb!.getFirstAsync(`SELECT typeof("${column}") AS t FROM "${table}"`, [])) as {
    t: string
  } | null
  return row?.t
}

async function rowCount(table: string): Promise<number> {
  const row = (await storage.sqliteDb!.getFirstAsync(`SELECT count(*) AS n FROM "${table}"`, [])) as { n: number }
  return row.n
}

const mangled = (bytes: number[]): unknown => JSON.parse(JSON.stringify(new Uint8Array(bytes)))

describe('byte columns on insert', () => {
  it('stores a number[] as a BLOB', async () => {
    await storage.insertProvenTx(provenTx([1, 2, 3]))
    expect(await storageClass('proven_txs', 'rawTx')).toBe('blob')
    expect(await storageClass('proven_txs', 'merklePath')).toBe('blob')
  })

  it('stores a Uint8Array as a BLOB and reads it back as the same bytes', async () => {
    await storage.insertProvenTx(provenTx(new Uint8Array([1, 2, 250])))
    expect(await storageClass('proven_txs', 'rawTx')).toBe('blob')
    const [back] = await storage.findProvenTxs({ partial: { txid: TXID } } as never)
    expect(Array.from(back.rawTx)).toEqual([1, 2, 250])
  })

  it('converts an ArrayBuffer to a BLOB', async () => {
    await storage.insertProvenTx(provenTx(new Uint8Array([4, 5]).buffer))
    expect(await storageClass('proven_txs', 'rawTx')).toBe('blob')
    const [back] = await storage.findProvenTxs({ partial: { txid: TXID } } as never)
    expect(Array.from(back.rawTx)).toEqual([4, 5])
  })

  it('refuses a JSON-rehydrated Uint8Array by column name and writes no row', async () => {
    expect(mangled([1, 2, 3])).toEqual({ '0': 1, '1': 2, '2': 3 })
    await expect(storage.insertProvenTx(provenTx(mangled([1, 2, 3])))).rejects.toThrow(/rawTx/)
    expect(await rowCount('proven_txs')).toBe(0)
  })

  it('refuses a string where bytes belong', async () => {
    await expect(storage.insertProvenTx(provenTx([1], 'deadbeef'))).rejects.toThrow(/merklePath/)
    expect(await rowCount('proven_txs')).toBe(0)
  })

  it('leaves an absent or null byte column empty rather than refusing it', async () => {
    const userId = await storage.insertUser({
      created_at: NOW,
      updated_at: NOW,
      userId: 0,
      identityKey: IDENTITY
    } as never)
    const base = {
      created_at: NOW,
      updated_at: NOW,
      transactionId: 0,
      userId,
      status: 'unsigned',
      isOutgoing: true,
      satoshis: 1,
      description: 'no bytes yet'
    }
    await storage.insertTransaction({ ...base, reference: 'absent' } as never)
    await storage.insertTransaction({ ...base, reference: 'null', rawTx: null, inputBEEF: null } as never)
    const rows = (await storage.sqliteDb!.getAllAsync(
      `SELECT reference, typeof(rawTx) AS raw, typeof(inputBEEF) AS beef FROM transactions ORDER BY reference`,
      []
    )) as { reference: string; raw: string; beef: string }[]
    expect(rows).toEqual([
      { reference: 'absent', raw: 'null', beef: 'null' },
      { reference: 'null', raw: 'null', beef: 'null' }
    ])
  })
})

describe('byte columns on update', () => {
  it('refuses a JSON-rehydrated Uint8Array and leaves the stored bytes untouched', async () => {
    const id = await storage.insertProvenTx(provenTx([1, 2, 3]))
    await expect(storage.updateProvenTx(id, { rawTx: mangled([9, 9]) } as never)).rejects.toThrow(/rawTx/)
    expect(await storageClass('proven_txs', 'rawTx')).toBe('blob')
    const [back] = await storage.findProvenTxs({ partial: { txid: TXID } } as never)
    expect(Array.from(back.rawTx)).toEqual([1, 2, 3])
  })

  it('still accepts a number[] on update', async () => {
    const id = await storage.insertProvenTx(provenTx([1, 2, 3]))
    await storage.updateProvenTx(id, { rawTx: [9, 9] } as never)
    expect(await storageClass('proven_txs', 'rawTx')).toBe('blob')
    const [back] = await storage.findProvenTxs({ partial: { txid: TXID } } as never)
    expect(Array.from(back.rawTx)).toEqual([9, 9])
  })
})
