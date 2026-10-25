/**
 * Key-value adapters over `StorageExpoSQLite`'s `key_value_store`.
 *
 * Two durable stores share the wallet's one KV table:
 *  - `createMandalaKvStorage` — the `@bsv/mandala` lib's `MandalaStorage`;
 *  - `createColorModuleStore` — the color permission module's
 *    `ColorModuleStore` (IC §2.1). The module owns every `color.v1.` key and
 *    its layout is internal to it: the wallet never reads those keys and
 *    calls the module's host-only `markSettled(txid)` instead.
 *
 * The same `createMandalaKvStorage` also backs the Mandala host ledger
 * (`mandala.host.v1.record.*`, design §9 B7), which no BRC-100 caller reaches.
 *
 * Get/set go through the storage's own `getKeyValue`/`setKeyValue` (an atomic
 * per-key upsert). Delete and prefix listing go straight to SQL because the
 * storage exposes neither, and both are hard failures when the database is
 * closed rather than silent no-ops: a delete that quietly did nothing would
 * leave a completed record behind forever, and an empty listing would read
 * as "nothing outstanding" when work is in fact pending.
 */
import type { ColorModuleStore } from '@bsv/color-permission-module'
import type { MandalaStorage } from '@bsv/mandala'

/** What the adapters need: the toolbox's own key/value table, plus raw SQL for the two verbs it lacks. */
export interface WalletKv {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
  readonly sqliteDb?: {
    runAsync(sql: string, params: (string | number | null)[]): Promise<{ changes: number }>
    getAllAsync(sql: string, params: (string | number | null)[]): Promise<unknown[]>
  }
}

type SqlHandle = NonNullable<WalletKv['sqliteDb']>

/** LIKE treats these as wildcards; a prefix containing one must still match literally. */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, c => `\\${c}`)
}

function sqlHandle(kv: WalletKv, owner: string): SqlHandle {
  const handle = kv.sqliteDb
  if (!handle) throw new Error(`${owner}: the wallet database is not open`)
  return handle
}

async function deleteKey(db: SqlHandle, key: string): Promise<void> {
  await db.runAsync('DELETE FROM key_value_store WHERE key = ?', [key])
}

/**
 * Every stored key that starts with `prefix`, compared exactly.
 *
 * The escaped `LIKE` narrows in SQL, but SQLite's `LIKE` is ASCII
 * case-insensitive by default, so its result is a superset: the
 * `startsWith` filter makes the match literal and case-sensitive.
 */
async function keysWithPrefix(db: SqlHandle, prefix: string): Promise<string[]> {
  const rows = (await db.getAllAsync(`SELECT key FROM key_value_store WHERE key LIKE ? ESCAPE '\\'`, [
    `${escapeLike(prefix)}%`
  ])) as { key: string }[]
  return rows.map(r => r.key).filter(key => key.startsWith(prefix))
}

/**
 * `MandalaStorage` over `StorageExpoSQLite`'s `key_value_store` (D3c).
 *
 * React Native has no `localStorage`, so without this adapter the lib
 * silently falls back to a process-lifetime Map and anything it journals
 * dies with the process.
 */
export function createMandalaKvStorage(kv: WalletKv): MandalaStorage {
  const db = (): SqlHandle => sqlHandle(kv, 'Mandala journal storage')
  return {
    getItem: async key => (await kv.getKeyValue(key)) ?? null,
    setItem: async (key, value) => {
      await kv.setKeyValue(key, value)
    },
    removeItem: async key => {
      await deleteKey(db(), key)
    },
    keys: async prefix => keysWithPrefix(db(), prefix)
  }
}

/**
 * The color module's durable store (IC §2.1) over `key_value_store`.
 *
 * The module's settlement records live here; losing a write would leave a
 * settled coin reading `color_offline`, so every failure propagates to the
 * module rather than being swallowed.
 */
export function createColorModuleStore(kv: WalletKv): ColorModuleStore {
  const db = (): SqlHandle => sqlHandle(kv, 'Color module store')
  return {
    get: async key => kv.getKeyValue(key),
    set: async (key, value) => {
      await kv.setKeyValue(key, value)
    },
    delete: async key => {
      await deleteKey(db(), key)
    },
    keys: async prefix => keysWithPrefix(db(), prefix)
  }
}
