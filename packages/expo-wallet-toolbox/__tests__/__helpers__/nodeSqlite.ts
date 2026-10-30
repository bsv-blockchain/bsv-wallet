/**
 * Real SQLite for jest: node:sqlite behind the slice of expo-sqlite's async
 * surface the wallet's storage code uses.
 *
 * Tests run the same `createTables()` the app runs on device and then the
 * same statements the code under test issues, so a drifted CHECK constraint
 * or a non-literal prefix query fails here rather than on a phone.
 *
 * Tests only. Never imported from `core/`.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import type { WalletKv } from '../../core/mandala/kvStore'

type Params = (string | number | null)[]

/** The expo-sqlite methods the wallet's storage code calls, over node:sqlite. */
export interface ExpoLikeDb {
  execAsync(sql: string): Promise<void>
  runAsync(sql: string, params?: Params): Promise<{ changes: number; lastInsertRowId: number }>
  getAllAsync<T = unknown>(sql: string, params?: Params): Promise<T[]>
  getFirstAsync<T = unknown>(sql: string, params?: Params): Promise<T | null>
  /** `BEGIN` / `COMMIT`, with `ROLLBACK` and a rethrow when `task` throws. */
  withTransactionAsync(task: () => Promise<void>): Promise<void>
}

/** expo-sqlite's async surface over node:sqlite's sync one. */
export function adapt(raw: DatabaseSync): ExpoLikeDb {
  return {
    execAsync: async sql => {
      raw.exec(sql)
    },
    runAsync: async (sql, params = []) => {
      const r = raw.prepare(sql).run(...(params as never[]))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    },
    getAllAsync: async <T>(sql: string, params: Params = []) => raw.prepare(sql).all(...(params as never[])) as T[],
    getFirstAsync: async <T>(sql: string, params: Params = []) =>
      (raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
    withTransactionAsync: async task => {
      raw.exec('BEGIN')
      try {
        await task()
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
      raw.exec('COMMIT')
    }
  }
}

/**
 * A `WalletKv` over `db`'s `key_value_store`, issuing the exact statements
 * `StorageExpoSQLite.getKeyValue` / `setKeyValue` issue.
 */
export function kvOver(db: ExpoLikeDb): WalletKv {
  return {
    getKeyValue: async key => {
      const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM key_value_store WHERE key = ?', [key])
      return row?.value
    },
    setKeyValue: async (key, value) => {
      await db.runAsync(
        `INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, new Date().toISOString()]
      )
    },
    sqliteDb: db
  }
}

/**
 * A fresh in-memory wallet database with every table `createTables()` makes.
 * `createTables` is async but node:sqlite is sync, so the schema exists once
 * the returned promise settles; callers close `raw` when done.
 */
export async function openTestDb(): Promise<{ raw: DatabaseSync; db: ExpoLikeDb; kv: WalletKv }> {
  const raw = new DatabaseSync(':memory:')
  const db = adapt(raw)
  await createTables(db as never)
  return { raw, db, kv: kvOver(db) }
}
