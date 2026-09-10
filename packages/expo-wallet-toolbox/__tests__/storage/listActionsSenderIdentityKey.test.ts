/**
 * listActions rows carry the payer's identity key, read from the outputs table
 * in one round trip per page.
 *
 * Run against the REAL schema via node:sqlite so the SQL that ships is the SQL
 * under test: a renamed column or a filter that stops matching fails here.
 */
import { DatabaseSync } from 'node:sqlite'
import type { sdk } from '@bsv/wallet-toolbox-mobile'

type TrxToken = sdk.TrxToken
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'

const NOW = '2026-09-01T00:00:00.000Z'
const KEY_A = '02' + 'a'.repeat(64)
const KEY_A_LATER_VOUT = '03' + 'c'.repeat(64)

function adapt(raw: DatabaseSync) {
  return {
    execAsync: async (sql: string) => raw.exec(sql),
    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as never[]))),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      raw.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as never[]))
  }
}

let raw: DatabaseSync
let db: ReturnType<typeof adapt>
let storage: StorageExpoSQLite

function insertTransaction(transactionId: number, reference: string): void {
  raw
    .prepare(
      `INSERT INTO transactions
       (transactionId, created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
       VALUES (?, ?, ?, 1, 'completed', ?, 0, 100, ?)`
    )
    .run(transactionId, NOW, NOW, reference, reference.padEnd(64, '0'))
}

function insertOutput(outputId: number, transactionId: number, vout: number, senderIdentityKey: string | null): void {
  raw
    .prepare(
      `INSERT INTO outputs
       (outputId, created_at, updated_at, userId, transactionId, vout, satoshis, providedBy, senderIdentityKey)
       VALUES (?, ?, ?, 1, ?, ?, 1, 'you', ?)`
    )
    .run(outputId, NOW, NOW, transactionId, vout, senderIdentityKey)
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = adapt(raw)
  await createTables(db as never)
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  storage.db = db as never
  raw
    .prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (1, ?, ?, ?)')
    .run(NOW, NOW, '02' + 'f'.repeat(64))

  // Tx A: a paid-in transaction whose outputs name the payer. vout 1 carries a
  // different key so the test can tell the lowest vout wins.
  insertTransaction(1, 'ref-A')
  insertOutput(1, 1, 1, KEY_A_LATER_VOUT)
  insertOutput(2, 1, 0, KEY_A)
  // Tx B: outputs exist but none identify a sender (NULL and the empty string
  // are both "no key").
  insertTransaction(2, 'ref-B')
  insertOutput(3, 2, 0, null)
  insertOutput(4, 2, 1, '')
  db.getAllAsync.mockClear()
})

afterEach(() => raw.close())

const auth = { userId: 1, identityKey: 'k' } as never

describe('listActions senderIdentityKey', () => {
  it('sets senderIdentityKey from the first keyed output and leaves it undefined otherwise', async () => {
    const r = await storage.listActions(auth, {
      labels: [],
      includeLabels: true,
      limit: 10,
      offset: 0
    } as never)

    expect(r.actions).toHaveLength(2)
    // The extras (reference, created_at, senderIdentityKey) sit outside the
    // SDK's WalletAction type, so rows are read as plain records here.
    const rows = r.actions as unknown as Record<string, unknown>[]
    const a = rows.find(x => x.reference === 'ref-A')!
    const b = rows.find(x => x.reference === 'ref-B')!
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    expect(a.senderIdentityKey).toBe(KEY_A)
    expect(b.senderIdentityKey).toBeUndefined()
    expect('senderIdentityKey' in b).toBe(false)

    // The existing extras are untouched.
    for (const row of [a, b]) {
      expect(typeof row.reference).toBe('string')
      expect(row.created_at).toEqual(new Date(NOW))
      expect(Array.isArray(row.labels)).toBe(true)
    }
  })

  it('reads the keys for the whole page in one query', async () => {
    await storage.listActions(auth, { labels: [], includeLabels: false, limit: 10, offset: 0 } as never)

    const keyReads = db.getAllAsync.mock.calls.filter(([sql]) => /senderIdentityKey/.test(sql as string))
    expect(keyReads).toHaveLength(1)
  })
})

describe('getSenderIdentityKeysForTransactionIds', () => {
  it('maps each transaction to its lowest-vout non-empty key', async () => {
    const map = await storage.getSenderIdentityKeysForTransactionIds([1, 2, 999])

    expect(map).toEqual(new Map([[1, KEY_A]]))
    expect(db.getAllAsync).toHaveBeenCalledTimes(1)
  })

  it('returns an empty map without touching storage for no ids', async () => {
    expect(await storage.getSenderIdentityKeysForTransactionIds([])).toEqual(new Map())
    expect(db.getAllAsync).not.toHaveBeenCalled()
  })

  it('splits the IN list so a statement never exceeds SQLite bound-variable limit', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1)

    const map = await storage.getSenderIdentityKeysForTransactionIds(ids)

    expect(map.get(1)).toBe(KEY_A)
    expect(db.getAllAsync).toHaveBeenCalledTimes(2)
    for (const [, params] of db.getAllAsync.mock.calls) {
      expect((params as unknown[]).length).toBeLessThanOrEqual(999)
    }
  })

  it('uses the supplied transaction connection for the lookup', async () => {
    const transactionDb = adapt(raw)
    const token = { _inTrx: true, db: transactionDb } as unknown as TrxToken

    expect(await storage.getSenderIdentityKeysForTransactionIds([1], token)).toEqual(new Map([[1, KEY_A]]))
    expect(transactionDb.getAllAsync).toHaveBeenCalledTimes(1)
    expect(db.getAllAsync).not.toHaveBeenCalled()
  })
})
