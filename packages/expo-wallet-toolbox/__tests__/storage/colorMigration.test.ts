/**
 * The one-time move off the Mandala σI settlement machinery: the four
 * settlement tables and the old lib's KV journals are dropped exactly once,
 * guarded by a marker, and `color_transfers` takes their place.
 *
 * The marker is what makes it safe to run on every boot: `@bsv/mandala` 0.5.0
 * keeps its own journals under the same `mandala.` prefix, and a second wipe
 * after the new lib has written one would lose a hand-over in flight.
 */
import { DatabaseSync } from 'node:sqlite'
import { migrateMandalaToColor, COLOR_MIGRATION_MARKER } from '../../core/mandala/transferJournal'
import { createTables } from '../../core/storage/schema/createTables'
import { adapt, openTestDb, type ExpoLikeDb } from '../__helpers__/nodeSqlite'

const LEGACY_TABLES = ['token_settlements', 'token_admissions', 'token_admission_edges', 'token_linkage_payloads']

function tableNames(raw: DatabaseSync): string[] {
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    r => r.name
  )
}

function indexNames(raw: DatabaseSync): string[] {
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
    r => r.name
  )
}

function kvKeys(raw: DatabaseSync): string[] {
  return (raw.prepare('SELECT key FROM key_value_store ORDER BY key').all() as { key: string }[]).map(r => r.key)
}

/** A pre-1color device: the KV table, the four settlement tables, old lib journals. */
function legacyDevice(): { raw: DatabaseSync; db: ExpoLikeDb } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE key_value_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE token_settlements (txid TEXT PRIMARY KEY, state TEXT NOT NULL, reference TEXT);
    CREATE INDEX idx_token_settlements_state ON token_settlements(state);
    CREATE TABLE token_admissions (txid TEXT PRIMARY KEY);
    CREATE TABLE token_admission_edges (childTxid TEXT, parentTxid TEXT, parentVout INTEGER);
    CREATE INDEX idx_token_admission_edges_child ON token_admission_edges(childTxid);
    CREATE TABLE token_linkage_payloads (txid TEXT PRIMARY KEY, payloadBytes BLOB);
  `)
  raw.prepare("INSERT INTO token_settlements VALUES ('aa', 'handed_over', 'r')").run()
  for (const k of ['mandala.txJournal.x', 'mandala.notifyJournal.y', 'mandala.blindingJournal.z', 'keep.me', 'MANDALA.Upper']) {
    raw.prepare("INSERT INTO key_value_store VALUES (?, '{}', 't')").run(k)
  }
  return { raw, db: adapt(raw) }
}

describe('migrateMandalaToColor', () => {
  it('drops the four Mandala tables and old lib journals once, guarded by a marker', async () => {
    const { raw, db } = legacyDevice()
    expect(await migrateMandalaToColor(db as never)).toBe('migrated')
    expect(tableNames(raw)).not.toEqual(expect.arrayContaining(['token_settlements']))
    for (const t of LEGACY_TABLES) expect(tableNames(raw)).not.toContain(t)
    expect(indexNames(raw).filter(i => i.startsWith('idx_token_'))).toEqual([])
    expect(tableNames(raw)).toEqual(expect.arrayContaining(['color_transfers']))
    expect(indexNames(raw)).toEqual(
      expect.arrayContaining(['idx_color_transfers_state', 'idx_color_transfers_reference', 'idx_color_transfers_createdAt'])
    )
    expect(kvKeys(raw)).toEqual(expect.arrayContaining(['keep.me', 'bsvwallet.migration.color.v1']))
    expect(COLOR_MIGRATION_MARKER).toBe('bsvwallet.migration.color.v1')
    expect(kvKeys(raw).filter(k => k.startsWith('mandala.'))).toEqual([])
    // The prefix match is exact: only the lib's own lower-case namespace goes.
    expect(kvKeys(raw)).toContain('MANDALA.Upper')

    raw.prepare("INSERT INTO key_value_store VALUES ('mandala.txJournal.new','{}','t')").run()
    expect(await migrateMandalaToColor(db as never)).toBe('already') // never wipes the new lib's journals
    expect(kvKeys(raw)).toContain('mandala.txJournal.new')
    raw.close()
  })

  it('never wipes again once the marker exists, even if a legacy table reappears', async () => {
    const { raw, db } = legacyDevice()
    await migrateMandalaToColor(db as never)
    raw.exec('CREATE TABLE token_admissions (txid TEXT PRIMARY KEY)')
    expect(await migrateMandalaToColor(db as never)).toBe('already')
    expect(tableNames(raw)).toContain('token_admissions')
    raw.close()
  })

  it('rolls back every step when one fails inside the transaction', async () => {
    const { raw, db } = legacyDevice()
    const failing: ExpoLikeDb = {
      ...db,
      execAsync: async sql => {
        if (/CREATE TABLE IF NOT EXISTS color_transfers/.test(sql)) throw new Error('disk I/O error')
        await db.execAsync(sql)
      }
    }
    await expect(migrateMandalaToColor(failing as never)).rejects.toThrow('disk I/O error')
    expect(tableNames(raw)).toContain('token_settlements')
    expect(kvKeys(raw)).toContain('mandala.txJournal.x')
    expect(kvKeys(raw)).not.toContain('bsvwallet.migration.color.v1')
    // The next boot simply runs it again.
    expect(await migrateMandalaToColor(db as never)).toBe('migrated')
    raw.close()
  })

  it('runs on a connection without withTransactionAsync, marker last', async () => {
    const { raw, db } = legacyDevice()
    const { withTransactionAsync: _omit, ...bare } = db
    expect(await migrateMandalaToColor(bare as never)).toBe('migrated')
    expect(tableNames(raw)).not.toContain('token_settlements')
    expect(kvKeys(raw)).toContain('bsvwallet.migration.color.v1')
    expect(await migrateMandalaToColor(bare as never)).toBe('already')
    raw.close()
  })
})

describe('createTables', () => {
  it('createTables on a fresh database runs the migration', async () => {
    const { raw } = await openTestDb()
    expect(tableNames(raw)).toContain('color_transfers')
    for (const t of LEGACY_TABLES) expect(tableNames(raw)).not.toContain(t)
    expect(kvKeys(raw)).toContain('bsvwallet.migration.color.v1')
    raw.close()
  })

  it('re-running createTables keeps the journal and its rows', async () => {
    const { raw, db } = await openTestDb()
    raw
      .prepare(
        `INSERT INTO color_transfers (txid, role, assetId, units, outputIndex, rail, state, createdAt, updatedAt)
         VALUES ('aa', 'sent', 'x', '1', 0, 'handle', 'built', 't', 't')`
      )
      .run()
    await createTables(db as never)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM color_transfers').get()).toEqual({ n: 1 })
    raw.close()
  })

  it('recreates color_transfers if it is missing after the marker was written', async () => {
    const { raw, db } = await openTestDb()
    raw.exec('DROP TABLE color_transfers')
    await createTables(db as never)
    expect(tableNames(raw)).toContain('color_transfers')
    raw.close()
  })
})
