/**
 * `color_transfers`: the wallet's one durable host record of a 1Color
 * transfer, and the one-time migration that replaced the four Mandala σI
 * settlement tables with it.
 *
 * The journal is the only key for the two incident guards (plan 07, W1): the
 * broadcast hold in `StorageExpoSQLite` (a tx with a 1Color output is held
 * unless its row reads `settled`; a missing row holds) and the abort refusal
 * (`abortGuard.ts`, by `reference`). Token custody and evidence live in the
 * color permission module, never here.
 *
 * Rules every method keeps:
 *  - `units` is a canonical decimal TEXT on disk and a `bigint` in memory. A
 *    value that does not read back exactly is a thrown error, never a
 *    coerced number (IC §0).
 *  - `insert` is `INSERT OR IGNORE` and reports whether it wrote, so a
 *    double-tapped send or a crash-and-retry never forks a row.
 *  - `advance` is one compare-and-set statement, so two concurrent callers
 *    (the drain tick racing a screen) can never both win a transition.
 *  - Read faults propagate. The guards above turn them into "hold" or
 *    "refuse"; swallowing one here would read as "no row" and fail open.
 *
 * This file imports types only: `createTables.ts` imports the migration from
 * here, and nothing here may import the schema file back.
 */
import type { SQLiteDatabase } from 'expo-sqlite'
import {
  COLOR_TRANSFER_RAILS,
  COLOR_TRANSFER_ROLES,
  COLOR_TRANSFER_STATES,
  type ColorTransferRail,
  type ColorTransferRole,
  type ColorTransferRow,
  type ColorTransferState
} from './types'

type Param = string | number | null

/** The two expo-sqlite methods the journal uses. `StorageExpoSQLite`'s connection satisfies it. */
export interface JournalDb {
  runAsync(sql: string, p: Param[]): Promise<{ changes: number }>
  getAllAsync(sql: string, p: Param[]): Promise<unknown[]>
}

export interface TransferJournal {
  get(txid: string): Promise<ColorTransferRow | undefined>
  /** The newest row built by the wallet action with this `createAction` reference. */
  getByReference(reference: string): Promise<ColorTransferRow | undefined>
  /** Newest `createdAt` first. An empty `states` list matches nothing. */
  list(filter?: { states?: ColorTransferState[]; role?: ColorTransferRole; limit?: number }): Promise<ColorTransferRow[]>
  /** `INSERT OR IGNORE`: true when this call wrote the row, false when it already existed (left untouched). */
  insert(row: Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>): Promise<boolean>
  /** Single-statement CAS: moves the row to `to` only if it is in one of `from`. The patch lands in the same statement. */
  advance(
    txid: string,
    from: readonly ColorTransferState[],
    to: ColorTransferState,
    patch?: { code?: string; delivered?: boolean }
  ): Promise<boolean>
  setDelivered(txid: string, delivered: boolean): Promise<void>
  /** The state of each txid that has a row. A txid with no row is absent from the map. Read faults propagate. */
  statesOf(txids: readonly string[]): Promise<Map<string, ColorTransferState>>
}

// ───────────────────────────────── schema ─────────────────────────────────

/** Written last by the migration; its presence means the one-time wipe has run. */
export const COLOR_MIGRATION_MARKER = 'bsvwallet.migration.color.v1'

/** The pre-1color settlement tables. Their indexes drop with them. */
export const LEGACY_MANDALA_TABLES = [
  'token_settlements',
  'token_admissions',
  'token_admission_edges',
  'token_linkage_payloads'
] as const

/**
 * The journal's DDL. Idempotent, and the single definition both the
 * migration and `createTables` run, so the two can never drift (the backup
 * import's schema allow-list is built from `createTables`).
 *
 * No CHECK constraints: the journal validates on every write and every read
 * instead, and a later state can be added without a table rebuild.
 */
export const COLOR_TRANSFERS_DDL = `
  CREATE TABLE IF NOT EXISTS color_transfers (
    txid              TEXT PRIMARY KEY,
    role              TEXT NOT NULL,
    assetId           TEXT NOT NULL,
    units             TEXT NOT NULL,
    outputIndex       INTEGER NOT NULL,
    counterpartyKey   TEXT,
    reference         TEXT,
    rail              TEXT NOT NULL,
    state             TEXT NOT NULL,
    delivered         INTEGER NOT NULL DEFAULT 0,
    code              TEXT,
    note              TEXT,
    derivationPrefix  TEXT,
    derivationSuffix  TEXT,
    senderIdentityKey TEXT,
    createdAt         TEXT NOT NULL,
    updatedAt         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_color_transfers_state ON color_transfers(state);
  CREATE INDEX IF NOT EXISTS idx_color_transfers_reference ON color_transfers(reference);
  CREATE INDEX IF NOT EXISTS idx_color_transfers_createdAt ON color_transfers(createdAt);
`

type MigrationDb = Pick<SQLiteDatabase, 'execAsync' | 'getAllAsync'> &
  Partial<Pick<SQLiteDatabase, 'withTransactionAsync'>>

/**
 * One-time move off the Mandala σI settlement machinery. Runs from
 * `createTables`, which runs on every boot before the runtime, the module or
 * `@bsv/mandala` exist, so no 0.5.0 lib journal can be written before the
 * wipe and none is ever wiped after it: the marker guards every later boot.
 *
 * Steps, in one transaction: marker present ⇒ 'already'; otherwise drop the
 * four tables, delete the old lib's `mandala.` KV journals (exact,
 * case-sensitive prefix), create `color_transfers`, write the marker. Every
 * step is idempotent and the marker is written last, so a crash at any point
 * converges on the next boot even without the transaction.
 *
 * `withTransactionAsync` is used when the connection has it (expo-sqlite
 * always does); otherwise the same steps run between an explicit
 * `BEGIN`/`COMMIT`, with `ROLLBACK` on a throw.
 */
export async function migrateMandalaToColor(db: MigrationDb): Promise<'migrated' | 'already'> {
  let outcome: 'migrated' | 'already' = 'already'
  const steps = async (): Promise<void> => {
    const marker = await db.getAllAsync('SELECT 1 AS found FROM key_value_store WHERE key = ?', [
      COLOR_MIGRATION_MARKER
    ])
    if (marker.length > 0) {
      outcome = 'already'
      return
    }
    for (const table of LEGACY_MANDALA_TABLES) await db.execAsync(`DROP TABLE IF EXISTS ${table}`)
    // GLOB, not LIKE: LIKE is case-insensitive and treats '_' as a wildcard.
    await db.execAsync(`DELETE FROM key_value_store WHERE key GLOB 'mandala.*'`)
    await db.execAsync(COLOR_TRANSFERS_DDL)
    // execAsync with literals (a constant key, a generated ISO timestamp):
    // createTables' callers include minimal connections with no runAsync.
    const at = new Date().toISOString()
    await db.execAsync(
      `INSERT OR IGNORE INTO key_value_store (key, value, updated_at) VALUES ('${COLOR_MIGRATION_MARKER}', '${at}', '${at}')`
    )
    outcome = 'migrated'
  }

  if (typeof db.withTransactionAsync === 'function') {
    await db.withTransactionAsync(steps)
  } else {
    await db.execAsync('BEGIN')
    try {
      await steps()
    } catch (e) {
      try {
        await db.execAsync('ROLLBACK')
      } catch {
        // The original fault is the one worth reporting.
      }
      throw e
    }
    await db.execAsync('COMMIT')
  }
  return outcome
}

// ──────────────────────────────── validation ────────────────────────────────

const TXID_RE = /^[0-9a-f]{64}$/
const ASSET_ID_RE = /^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$/
const UNITS_RE = /^(0|[1-9][0-9]*)$/
/** Stay well under SQLite's bound-parameter ceiling on every build. */
const STATES_OF_CHUNK = 500

function fail(what: string, value: unknown): never {
  throw new Error(`color_transfers: invalid ${what} ${JSON.stringify(typeof value === 'bigint' ? `${value}n` : value)}`)
}

function checkState(state: unknown): ColorTransferState {
  if (!COLOR_TRANSFER_STATES.includes(state as ColorTransferState)) fail('state', state)
  return state as ColorTransferState
}

function checkTxid(txid: unknown): string {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) fail('txid', txid)
  return txid
}

function unitsToText(units: unknown): string {
  if (typeof units !== 'bigint' || units < 0n) fail('units', units)
  return units.toString()
}

function unitsFromText(text: unknown): bigint {
  if (typeof text !== 'string' || !UNITS_RE.test(text)) fail('units', text)
  return BigInt(text)
}

function checkIndex(n: unknown): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) fail('outputIndex', n)
  return n
}

function optText(v: unknown, what: string): string | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v !== 'string') fail(what, v)
  return v
}

interface DbRow {
  txid: unknown
  role: unknown
  assetId: unknown
  units: unknown
  outputIndex: unknown
  counterpartyKey: unknown
  reference: unknown
  rail: unknown
  state: unknown
  delivered: unknown
  code: unknown
  note: unknown
  derivationPrefix: unknown
  derivationSuffix: unknown
  senderIdentityKey: unknown
  createdAt: unknown
  updatedAt: unknown
}

/** A row exactly as written, or a throw. Never a best-effort guess. */
function fromDb(r: DbRow): ColorTransferRow {
  if (!COLOR_TRANSFER_ROLES.includes(r.role as ColorTransferRole)) fail('role', r.role)
  if (!COLOR_TRANSFER_RAILS.includes(r.rail as ColorTransferRail)) fail('rail', r.rail)
  if (typeof r.assetId !== 'string') fail('assetId', r.assetId)
  if (r.delivered !== 0 && r.delivered !== 1) fail('delivered', r.delivered)
  if (typeof r.createdAt !== 'string') fail('createdAt', r.createdAt)
  if (typeof r.updatedAt !== 'string') fail('updatedAt', r.updatedAt)
  const row: ColorTransferRow = {
    txid: checkTxid(r.txid),
    role: r.role as ColorTransferRole,
    assetId: r.assetId,
    units: unitsFromText(r.units),
    outputIndex: checkIndex(r.outputIndex),
    rail: r.rail as ColorTransferRail,
    state: checkState(r.state),
    delivered: r.delivered === 1,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
  const optional = {
    counterpartyKey: optText(r.counterpartyKey, 'counterpartyKey'),
    reference: optText(r.reference, 'reference'),
    code: optText(r.code, 'code'),
    note: optText(r.note, 'note'),
    derivationPrefix: optText(r.derivationPrefix, 'derivationPrefix'),
    derivationSuffix: optText(r.derivationSuffix, 'derivationSuffix'),
    senderIdentityKey: optText(r.senderIdentityKey, 'senderIdentityKey')
  }
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v
  return row
}

const COLUMNS =
  'txid, role, assetId, units, outputIndex, counterpartyKey, reference, rail, state, delivered, code, note, derivationPrefix, derivationSuffix, senderIdentityKey, createdAt, updatedAt'

// ───────────────────────────────── journal ─────────────────────────────────

export function createTransferJournal(db: JournalDb, now: () => Date = () => new Date()): TransferJournal {
  const select = async (where: string, params: Param[], tail = ''): Promise<ColorTransferRow[]> => {
    const rows = (await db.getAllAsync(`SELECT ${COLUMNS} FROM color_transfers ${where} ${tail}`, params)) as DbRow[]
    return rows.map(fromDb)
  }

  return {
    async get(txid) {
      const [row] = await select('WHERE txid = ?', [txid], 'LIMIT 1')
      return row
    },

    async getByReference(reference) {
      const [row] = await select('WHERE reference = ?', [reference], 'ORDER BY createdAt DESC, rowid DESC LIMIT 1')
      return row
    },

    async list(filter = {}) {
      const clauses: string[] = []
      const params: Param[] = []
      if (filter.states !== undefined) {
        if (filter.states.length === 0) return []
        filter.states.forEach(checkState)
        clauses.push(`state IN (${filter.states.map(() => '?').join(',')})`)
        params.push(...filter.states)
      }
      if (filter.role !== undefined) {
        if (!COLOR_TRANSFER_ROLES.includes(filter.role)) fail('role', filter.role)
        clauses.push('role = ?')
        params.push(filter.role)
      }
      let tail = 'ORDER BY createdAt DESC, rowid DESC'
      if (filter.limit !== undefined) {
        if (!Number.isSafeInteger(filter.limit) || filter.limit < 0) fail('limit', filter.limit)
        if (filter.limit === 0) return []
        tail += ' LIMIT ?'
        params.push(filter.limit)
      }
      return await select(clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params, tail)
    },

    async insert(row) {
      checkTxid(row.txid)
      if (!COLOR_TRANSFER_ROLES.includes(row.role)) fail('role', row.role)
      if (!COLOR_TRANSFER_RAILS.includes(row.rail)) fail('rail', row.rail)
      if (typeof row.assetId !== 'string' || !ASSET_ID_RE.test(row.assetId)) fail('assetId', row.assetId)
      checkState(row.state)
      const units = unitsToText(row.units)
      const outputIndex = checkIndex(row.outputIndex)
      if (typeof row.delivered !== 'boolean') fail('delivered', row.delivered)
      const at = now().toISOString()
      const r = await db.runAsync(
        `INSERT OR IGNORE INTO color_transfers (${COLUMNS}) VALUES (${COLUMNS.split(',')
          .map(() => '?')
          .join(', ')})`,
        [
          row.txid,
          row.role,
          row.assetId,
          units,
          outputIndex,
          row.counterpartyKey ?? null,
          row.reference ?? null,
          row.rail,
          row.state,
          row.delivered ? 1 : 0,
          row.code ?? null,
          row.note ?? null,
          row.derivationPrefix ?? null,
          row.derivationSuffix ?? null,
          row.senderIdentityKey ?? null,
          at,
          at
        ]
      )
      return r.changes === 1
    },

    async advance(txid, from, to, patch = {}) {
      checkState(to)
      from.forEach(checkState)
      if (from.length === 0) return false
      const sets = ['state = ?', 'updatedAt = ?']
      const params: Param[] = [to, now().toISOString()]
      if (patch.code !== undefined) {
        sets.push('code = ?')
        params.push(patch.code)
      }
      if (patch.delivered !== undefined) {
        sets.push('delivered = ?')
        params.push(patch.delivered ? 1 : 0)
      }
      params.push(txid, ...from)
      const r = await db.runAsync(
        `UPDATE color_transfers SET ${sets.join(', ')} WHERE txid = ? AND state IN (${from.map(() => '?').join(',')})`,
        params
      )
      return r.changes === 1
    },

    async setDelivered(txid, delivered) {
      await db.runAsync('UPDATE color_transfers SET delivered = ?, updatedAt = ? WHERE txid = ?', [
        delivered ? 1 : 0,
        now().toISOString(),
        txid
      ])
    },

    async statesOf(txids) {
      const out = new Map<string, ColorTransferState>()
      const unique = [...new Set(txids)]
      for (let i = 0; i < unique.length; i += STATES_OF_CHUNK) {
        const chunk = unique.slice(i, i + STATES_OF_CHUNK)
        const rows = (await db.getAllAsync(
          `SELECT txid, state FROM color_transfers WHERE txid IN (${chunk.map(() => '?').join(',')})`,
          chunk
        )) as { txid: string; state: unknown }[]
        for (const r of rows) out.set(r.txid, checkState(r.state))
      }
      return out
    }
  }
}
