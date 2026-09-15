/**
 * The one-time 'mandala-tokens' -> MANDALA_BASKET ('p mandala') rename
 * (offline-settlement-final.md §8.3), run against the REAL schema via
 * node:sqlite — same pattern as walletBalanceSql.test.ts: a filter or column
 * mismatch against the actual `outputs`/`output_baskets` tables fails here,
 * not on a real device.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { migrateMandalaBasketName, OLD_MANDALA_BASKET_NAME } from '../../core/mandala/basketMigration'
import { MANDALA_BASKET } from '../../core/mandala/types'

/**
 * expo-sqlite's async surface over node:sqlite's sync one — mirrors
 * walletBalanceSql.test.ts's adapter, only the handful of methods used here.
 *
 * node:sqlite's `.run()` returns `lastInsertRowid` (lowercase 'id', the
 * native sqlite3 C API's own casing); expo-sqlite's RunResult type — which
 * `StorageExpoSQLite.sqlInsert` reads via `result.lastInsertRowId` — is
 * camelCased differently. `findOrInsertOutputBasket`/`insertOutput*` depend
 * on that return value to report the new row's id, so this remaps it rather
 * than letting every insert silently report `undefined`.
 */
function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => {
      const result = db.prepare(sql).run(...(params as never[]))
      return { ...result, lastInsertRowId: Number(result.lastInsertRowid) }
    }
  }
}
type Db = ReturnType<typeof adapt>

const NOW = '2026-09-14T00:00:00.000Z'
let raw: DatabaseSync
let db: Db
let storage: StorageExpoSQLite

async function seedBasket(name: string, userId: number): Promise<number> {
  await db.runAsync(
    `INSERT INTO output_baskets (created_at, updated_at, userId, name, numberOfDesiredUTXOs, minimumDesiredUTXOValue)
     VALUES (?, ?, ?, ?, 6, 1000)`,
    [NOW, NOW, userId, name]
  )
  const row = (await db.getFirstAsync('SELECT MAX(basketId) as basketId FROM output_baskets', [])) as {
    basketId: number
  }
  return row.basketId
}

/** Inserts one transaction and one output in `basketId`, returns the outputId. */
async function seedOutput(basketId: number, userId: number): Promise<number> {
  await db.runAsync(
    `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
     VALUES (?, ?, ?, 'completed', ?, 0, 1, ?)`,
    [NOW, NOW, userId, `ref-${Math.random()}`, 'a'.repeat(64)]
  )
  const txRow = (await db.getFirstAsync('SELECT MAX(transactionId) as transactionId FROM transactions', [])) as {
    transactionId: number
  }
  await db.runAsync(
    `INSERT INTO outputs (created_at, updated_at, userId, transactionId, basketId, spendable, change,
       vout, satoshis, providedBy, txid, lockingScript)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, 'you', ?, ?)`,
    [NOW, NOW, userId, txRow.transactionId, basketId, 'b'.repeat(64), new Uint8Array(25)]
  )
  const outRow = (await db.getFirstAsync('SELECT MAX(outputId) as outputId FROM outputs', [])) as {
    outputId: number
  }
  return outRow.outputId
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = adapt(raw)
  await createTables(db as never)
  // The real provider, over the real engine: only the native handle is
  // swapped out. `_settings` gates insertOutputBasket/updateOutput's
  // validateEntityForInsert/validatePartialForUpdate (verifyReadyForDatabaseAccess) —
  // migrate() would normally set it from a real settings row; stubbed here
  // since only its truthiness is read on this path.
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  ;(storage as unknown as { db: unknown }).db = db
  ;(storage as unknown as { _settings: unknown })._settings = { dbtype: 'SQLite' }

  // node:sqlite enforces foreign keys, so every userId a test seeds under has
  // to exist first (output_baskets/transactions/outputs all FK to users).
  for (const identityKey of ['02' + 'a'.repeat(62), '02' + 'b'.repeat(62)]) {
    await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
      NOW,
      NOW,
      identityKey
    ])
  }
})

afterEach(() => {
  raw.close()
})

describe('migrateMandalaBasketName', () => {
  it('is a no-op when zero rows carry the old basket name, and still marks done', async () => {
    const result = await migrateMandalaBasketName(storage)
    expect(result).toEqual({ ran: true, basketsMigrated: 0, movedOutputs: 0 })
    await expect(storage.getKeyValue('mandala_basket_migration_v1')).resolves.toBe('done')
  })

  it('is a no-op when the old basket exists but holds no outputs', async () => {
    await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    const result = await migrateMandalaBasketName(storage)
    expect(result).toEqual({ ran: true, basketsMigrated: 0, movedOutputs: 0 })
  })

  it('moves every output from the old basket to MANDALA_BASKET, creating the destination basket', async () => {
    const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    const outputId1 = await seedOutput(oldBasketId, 1)
    const outputId2 = await seedOutput(oldBasketId, 1)

    const result = await migrateMandalaBasketName(storage)
    expect(result.ran).toBe(true)
    expect(result.basketsMigrated).toBe(1)
    expect(result.movedOutputs).toBe(2)

    const newBaskets = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
    expect(newBaskets).toHaveLength(1)

    const movedOutputs = await storage.findOutputs({ partial: { basketId: newBaskets[0].basketId } })
    expect(movedOutputs.map(o => o.outputId).sort()).toEqual([outputId1, outputId2].sort())

    // Nothing left behind under the old basket.
    const oldOutputs = await storage.findOutputs({ partial: { basketId: oldBasketId } })
    expect(oldOutputs).toHaveLength(0)
  })

  it('reuses an existing MANDALA_BASKET row for the user instead of creating a duplicate', async () => {
    const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    const existingNewBasketId = await seedBasket(MANDALA_BASKET, 1)
    await seedOutput(oldBasketId, 1)

    await migrateMandalaBasketName(storage)

    const newBaskets = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
    expect(newBaskets).toHaveLength(1)
    expect(newBaskets[0].basketId).toBe(existingNewBasketId)
  })

  it('migrates each user independently', async () => {
    const oldBasketUser1 = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    const oldBasketUser2 = await seedBasket(OLD_MANDALA_BASKET_NAME, 2)
    await seedOutput(oldBasketUser1, 1)
    await seedOutput(oldBasketUser2, 2)
    await seedOutput(oldBasketUser2, 2)

    const result = await migrateMandalaBasketName(storage)
    expect(result.basketsMigrated).toBe(2)
    expect(result.movedOutputs).toBe(3)

    const user1New = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
    const user2New = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 2 } })
    expect(await storage.findOutputs({ partial: { basketId: user1New[0].basketId } })).toHaveLength(1)
    expect(await storage.findOutputs({ partial: { basketId: user2New[0].basketId } })).toHaveLength(2)
  })

  it('is idempotent: a second call is a marker-guarded no-op and never double-moves', async () => {
    const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    await seedOutput(oldBasketId, 1)
    await seedOutput(oldBasketId, 1)

    const first = await migrateMandalaBasketName(storage)
    expect(first).toEqual({ ran: true, basketsMigrated: 1, movedOutputs: 2 })

    const second = await migrateMandalaBasketName(storage)
    expect(second).toEqual({ ran: false, basketsMigrated: 0, movedOutputs: 0 })

    const newBaskets = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
    expect(newBaskets).toHaveLength(1)
    const movedOutputs = await storage.findOutputs({ partial: { basketId: newBaskets[0].basketId } })
    expect(movedOutputs).toHaveLength(2)
  })

  it('would not double-move even without the marker, since the old basket is left empty after the first pass', async () => {
    const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
    await seedOutput(oldBasketId, 1)

    await migrateMandalaBasketName(storage)
    // Simulate "marker forgotten" by clearing it directly, then run again.
    await storage.setKeyValue('mandala_basket_migration_v1', 'not-done')
    const rerun = await migrateMandalaBasketName(storage)

    // The UPDATE's own WHERE clause (basketId = old basket) now matches zero
    // rows, so nothing moves a second time even though `ran` reports true.
    expect(rerun.movedOutputs).toBe(0)
  })

  describe('the per-user pass (adversarial-review finding 6)', () => {
    it('migrates a restored backup\'s old-named rows for the current user even though the marker already says done', async () => {
      // The full scan already ran on this device (for a different user) and
      // set the marker -- simulating "this device shipped the rename a long
      // time ago".
      const otherUserOldBasket = await seedBasket(OLD_MANDALA_BASKET_NAME, 2)
      await seedOutput(otherUserOldBasket, 2)
      const first = await migrateMandalaBasketName(storage)
      expect(first).toEqual({ ran: true, basketsMigrated: 1, movedOutputs: 1 })

      // A backup restore now reintroduces old-named rows for user 1 (e.g. an
      // older snapshot, taken before this device's own migration ran).
      const restoredOldBasket = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
      const restoredOutputId = await seedOutput(restoredOldBasket, 1)

      // Without a currentUserId, the marker short-circuits everything -- the
      // restored rows are NOT touched (this is the pre-finding-6 gap).
      const withoutUserId = await migrateMandalaBasketName(storage)
      expect(withoutUserId).toEqual({ ran: false, basketsMigrated: 0, movedOutputs: 0 })
      expect(await storage.findOutputs({ partial: { basketId: restoredOldBasket } })).toHaveLength(1)

      // With currentUserId, the cheap single-user pass catches it even
      // though the full-scan marker is already 'done'.
      const result = await migrateMandalaBasketName(storage, 1)
      expect(result.ran).toBe(true)
      expect(result.basketsMigrated).toBe(1)
      expect(result.movedOutputs).toBe(1)

      const newBaskets = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
      expect(newBaskets).toHaveLength(1)
      const movedOutputs = await storage.findOutputs({ partial: { basketId: newBaskets[0].basketId } })
      expect(movedOutputs.map(o => o.outputId)).toEqual([restoredOutputId])
      expect(await storage.findOutputs({ partial: { basketId: restoredOldBasket } })).toHaveLength(0)
    })

    it('is a no-op (ran: false) for a user with nothing under the old basket name', async () => {
      const result = await migrateMandalaBasketName(storage, 1)
      expect(result).toEqual({ ran: true, basketsMigrated: 0, movedOutputs: 0 })

      // Second call: the full scan's marker is now set (0 rows found, but it
      // still ran once) and the per-user pass still finds nothing.
      const second = await migrateMandalaBasketName(storage, 1)
      expect(second).toEqual({ ran: false, basketsMigrated: 0, movedOutputs: 0 })
    })

    it('never double-moves when the per-user pass and the full scan overlap in the same call', async () => {
      const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
      await seedOutput(oldBasketId, 1)
      await seedOutput(oldBasketId, 1)

      // Marker not yet set -- both the full scan AND the per-user pass run
      // in this one call, for the SAME user.
      const result = await migrateMandalaBasketName(storage, 1)
      expect(result.movedOutputs).toBe(2)
      expect(result.basketsMigrated).toBe(1)

      const newBaskets = await storage.findOutputBaskets({ partial: { name: MANDALA_BASKET, userId: 1 } })
      expect(newBaskets).toHaveLength(1)
      const movedOutputs = await storage.findOutputs({ partial: { basketId: newBaskets[0].basketId } })
      expect(movedOutputs).toHaveLength(2)
    })

    it('omitting currentUserId reproduces the exact original marker-only behavior', async () => {
      const oldBasketId = await seedBasket(OLD_MANDALA_BASKET_NAME, 1)
      await seedOutput(oldBasketId, 1)

      const result = await migrateMandalaBasketName(storage)
      expect(result).toEqual({ ran: true, basketsMigrated: 1, movedOutputs: 1 })

      const second = await migrateMandalaBasketName(storage)
      expect(second).toEqual({ ran: false, basketsMigrated: 0, movedOutputs: 0 })
    })
  })
})
