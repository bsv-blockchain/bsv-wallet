/**
 * NEW-01 — `@bsv/wallet-toolbox-mobile` 2.14.0's BRC-177 `noSendExpiry`
 * lifecycle reads and writes `transactions` columns (`noSendExpiryState`,
 * `noSendExpiryReclaimTxid`, and the rest of the `noSendExpiry*` family —
 * grep `node_modules/@bsv/wallet-toolbox-mobile/out/index.mobile.cjs` for
 * `noSendExpiry`) that this package's own schema
 * (`core/storage/schema/createTables.ts`) never added.
 *
 * `StorageProvider.updateTransactionStatus('failed')` unconditionally calls
 * `protectNoSendExpiryReclaimInputOnFailure`, which filters `findTransactions`
 * on `noSendExpiryReclaimTxid` — so on the unfixed app schema that WHERE
 * clause throws `SQLITE_ERROR: no such column: noSendExpiryReclaimTxid` for
 * EVERY failed-transition of a transaction with a txid: `abortAction` of any
 * signed action, failed broadcasts, proof timeouts, and `reviewStatus`'s own
 * `failInvalidReqTxs` path all reach this same shared vendor method, so the
 * fix (and this regression coverage) is at that one root, not per-caller.
 *
 * Real `StorageExpoSQLite` on `node:sqlite` throughout — no columns are added
 * in this file itself, which is exactly how `abortActionChainStatus.test.ts`
 * and `xq016VaultAbortRealVendorInteraction.test.ts` used to hide this gap
 * with their own ad hoc `ALTER TABLE` workaround (since removed from both, now
 * that the real migration in `createTables.ts` covers it).
 */
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) {
      this.db.exec(sql)
    }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...(params as never[]))
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).get(...(params as never[])) ?? null
    }
    async getAllAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).all(...(params as never[]))
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

import { DatabaseSync } from 'node:sqlite'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { ensureTransactionsColumns } from '../../core/storage/schema/createTables'

const IDENTITY = '02' + 'ab'.repeat(32)
const TXID = 'cc'.repeat(32)
const OTHER_TXID = 'dd'.repeat(32)
const NOW = new Date('2026-09-25T00:00:00Z')

/** The full `noSendExpiry*` column family the vendor reads/writes. */
const NO_SEND_EXPIRY_COLUMNS = [
  'noSendExpiryMode',
  'noSendExpiryValue',
  'noSendExpiryDeadline',
  'noSendExpiryState',
  'noSendExpiryAnchorTxid',
  'noSendExpiryAnchorVout',
  'noSendExpiryReleasedAt',
  'noSendExpiryObservedAt',
  'noSendExpiryReclaimTxid',
  'noSendExpiryReclaimRawTx',
  'noSendExpiryReclaimDerivationPrefix',
  'noSendExpiryReclaimDerivationSuffix',
  'noSendExpiryReclaimSatoshis'
]

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[]))
  }
}

let storage: StorageExpoSQLite

beforeEach(async () => {
  storage = new StorageExpoSQLite({ chain: 'test', identityKey: IDENTITY, databaseName: 'new-01-test' } as never)
  await storage.migrate('test', IDENTITY)
})

afterEach(async () => {
  await storage.destroy()
})

describe('NEW-01: transactions table carries the vendor’s BRC-177 noSendExpiry* columns', () => {
  it('a fresh database has every column the vendor reads/writes', async () => {
    const cols = (await (storage.sqliteDb as never as ReturnType<typeof adapt>).getAllAsync(
      'PRAGMA table_info(transactions)',
      []
    )) as { name: string }[]
    const names = new Set(cols.map(c => c.name))
    for (const col of NO_SEND_EXPIRY_COLUMNS) expect(names.has(col)).toBe(true)
  })

  it('adds the columns to a pre-NEW-01 database that lacks them, without disturbing existing rows', async () => {
    // The exact pre-migration shape createTables.ts's own `transactions` CREATE
    // TABLE produces today, plus one live row — a device that upgraded before
    // this migration existed.
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
      CREATE TABLE transactions (
        transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        userId INTEGER NOT NULL,
        status TEXT NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        isOutgoing INTEGER NOT NULL DEFAULT 0,
        satoshis INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        version INTEGER,
        lockTime INTEGER,
        txid TEXT,
        inputBEEF BLOB,
        rawTx BLOB,
        provenTxId INTEGER
      );
    `)
    legacy.prepare(
      `INSERT INTO transactions (transactionId, created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
       VALUES (1,'n','n',7,'completed','legacy-ref',1,1000,?)`
    ).run(TXID)

    await ensureTransactionsColumns(adapt(legacy) as never)
    // Idempotent: a second boot must not throw "duplicate column name".
    await ensureTransactionsColumns(adapt(legacy) as never)

    const cols = (legacy.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map(c => c.name)
    for (const col of NO_SEND_EXPIRY_COLUMNS) expect(cols).toContain(col)
    expect(new Set(cols).size).toBe(cols.length)

    const row = legacy.prepare('SELECT * FROM transactions WHERE transactionId = 1').get() as Record<
      string,
      unknown
    >
    expect(row.txid).toBe(TXID)
    expect(row.reference).toBe('legacy-ref')
    expect(row.noSendExpiryState).toBeNull()
    legacy.close()
  })

  it(
    'NEW-01: updateTransactionStatus("failed") does not throw "no such column" for an ordinary ' +
      'signed nosend transaction, and still releases its reserved input',
    async () => {
      const userId = await storage.insertUser({
        created_at: NOW,
        updated_at: NOW,
        userId: 0,
        identityKey: IDENTITY
      } as never)

      const parentId = await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'completed',
        reference: 'parent-ref',
        isOutgoing: false,
        satoshis: 1000,
        description: 'funding',
        txid: OTHER_TXID
      } as never)
      const inputOutputId = await storage.insertOutput({
        created_at: NOW,
        updated_at: NOW,
        outputId: 0,
        userId,
        transactionId: parentId,
        spendable: false,
        change: true,
        vout: 0,
        satoshis: 1000,
        providedBy: 'storage',
        txid: OTHER_TXID
      } as never)

      const transactionId = await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'nosend',
        reference: 'the-signed-action',
        isOutgoing: true,
        satoshis: -1000,
        description: 'an ordinary signed nosend action',
        txid: TXID
      } as never)
      await storage.updateOutput(inputOutputId, { spendable: false, spentBy: transactionId } as never)

      // THE REGRESSION: on the unfixed app schema this rejects with
      // "SQLITE_ERROR: no such column: noSendExpiryReclaimTxid" instead of
      // completing the failed transition and releasing the input — leaving
      // the transaction stuck and the input permanently reserved.
      await expect(storage.updateTransactionStatus('failed', transactionId)).resolves.toBeUndefined()

      const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true } as never))[0] as {
        status: string
      }
      expect(tx.status).toBe('failed')

      const input = (await storage.findOutputs({ partial: { outputId: inputOutputId } } as never))[0] as {
        spendable: boolean
        spentBy?: number
      }
      expect(input.spendable).toBe(true)
      expect(input.spentBy).toBeUndefined()
    }
  )

  it(
    'NEW-01: a real BRC-177 reclaim link is honoured, not merely tolerated — ' +
      'protectNoSendExpiryReclaimInputOnFailure withholds the input release',
    async () => {
      const userId = await storage.insertUser({
        created_at: NOW,
        updated_at: NOW,
        userId: 0,
        identityKey: IDENTITY
      } as never)

      const parentId = await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'completed',
        reference: 'parent-ref',
        isOutgoing: false,
        satoshis: 1000,
        description: 'funding',
        txid: OTHER_TXID
      } as never)
      const inputOutputId = await storage.insertOutput({
        created_at: NOW,
        updated_at: NOW,
        outputId: 0,
        userId,
        transactionId: parentId,
        spendable: false,
        change: true,
        vout: 0,
        satoshis: 1000,
        providedBy: 'storage',
        txid: OTHER_TXID
      } as never)

      // The BRC-177 protected action whose failure must NOT release the coin
      // above — a signed reclaim already exists for it.
      const transactionId = await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'nosend',
        reference: 'the-protected-action',
        isOutgoing: true,
        satoshis: -1000,
        description: 'a BRC-177 protected action with an armed reclaim',
        txid: TXID
      } as never)
      await storage.updateOutput(inputOutputId, { spendable: false, spentBy: transactionId } as never)

      // A second row whose noSendExpiryReclaimTxid points back at TXID — the
      // shape `protectNoSendExpiryReclaimInputOnFailure` looks for.
      await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'unsigned',
        reference: 'the-reclaim-action',
        isOutgoing: true,
        satoshis: 1000,
        description: 'the armed reclaim of the transaction above',
        noSendExpiryReclaimTxid: TXID
      } as never)

      await storage.updateTransactionStatus('failed', transactionId)

      const input = (await storage.findOutputs({ partial: { outputId: inputOutputId } } as never))[0] as {
        spendable: boolean
      }
      // protectNoSendExpiryReclaimInputOnFailure found the reclaim row and
      // returned true, so releaseInputsAllocatedToFailedTransaction was never
      // called for this input — it stays reserved for the reclaim.
      expect(input.spendable).toBe(false)
    }
  )

  it('NEW-01: a noRawTx-projected read still returns noSendExpiryState (findSql.ts TABLE_COLUMNS)', async () => {
    const userId = await storage.insertUser({
      created_at: NOW,
      updated_at: NOW,
      userId: 0,
      identityKey: IDENTITY
    } as never)
    const transactionId = await storage.insertTransaction({
      created_at: NOW,
      updated_at: NOW,
      transactionId: 0,
      userId,
      status: 'nosend',
      reference: 'brc177-ref',
      isOutgoing: true,
      satoshis: -1000,
      description: 'signed and armed',
      txid: TXID,
      noSendExpiryState: 'signed'
    } as never)

    const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true } as never))[0] as {
      noSendExpiryState?: string
    }
    // Before the findSql.ts TABLE_COLUMNS fix, a noRawTx projection silently
    // dropped this column even though it exists in the table.
    expect(tx.noSendExpiryState).toBe('signed')
  })
})
