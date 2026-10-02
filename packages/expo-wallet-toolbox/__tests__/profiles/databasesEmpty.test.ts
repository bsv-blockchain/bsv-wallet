/**
 * The proof of emptiness for the databases that are NOT open: the other
 * networks' files of the same identity, and the profile's own once its wallet is
 * down. Run against real SQLite (node:sqlite standing in for expo-sqlite) with
 * the app's own schema, the way assertProfileEmpty.test does.
 *
 * What must hold: removal deletes a profile's database on every network, so
 * nothing in any of them may be left behind a tombstone — and a file that
 * cannot be read says nothing, so it blocks.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import {
  assertDatabasesEmpty,
  assertOtherNetworksEmpty,
  combineEmpty,
  type ClosedProfileDb,
  type DatabasesEmptyDeps
} from '../../core/profiles/assertProfileEmpty'
import { PENDING_KEY } from '../../core/localpay/pending'

const NOW = '2026-10-01T00:00:00.000Z'
const IDENTITY = '02' + 'ab'.repeat(32)
const OTHER_IDENTITY = '03' + 'cd'.repeat(32)
const MAIN_DB = 'wallet-abababab-mainnet-1760000000.db'
const TEST_DB = 'wallet-abababab-testnet-1760000001.db'

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

/** One migrated database with `identity` as its only user. */
async function walletDb(identity: string | null): Promise<{ raw: DatabaseSync; userId: number }> {
  const raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  let userId = 0
  if (identity) {
    const r = raw
      .prepare('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)')
      .run(NOW, NOW, identity)
    userId = Number(r.lastInsertRowid)
  }
  return { raw, userId }
}

function addSpendable(raw: DatabaseSync, userId: number): void {
  const tx = raw
    .prepare('INSERT INTO transactions (created_at, updated_at, userId, status, reference) VALUES (?, ?, ?, ?, ?)')
    .run(NOW, NOW, userId, 'completed', 'ref-1')
  raw
    .prepare(
      `INSERT INTO outputs (created_at, updated_at, userId, transactionId, spendable, vout, satoshis, providedBy)
       VALUES (?, ?, ?, ?, 1, 0, 1000, 'you')`
    )
    .run(NOW, NOW, userId, Number(tx.lastInsertRowid))
}

function setKv(raw: DatabaseSync, key: string, value: string): void {
  raw.prepare('INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, NOW)
}

/** The files, as `open` hands them out; `closed` records every file closed, in order. */
function fakeDeps(files: Record<string, DatabaseSync | Error>, over: Partial<DatabasesEmptyDeps> = {}) {
  const closed: string[] = []
  const opened: string[] = []
  const deps: DatabasesEmptyDeps = {
    list: async () => Object.keys(files),
    open: async filename => {
      opened.push(filename)
      const file = files[filename]
      if (file instanceof Error) throw file
      return { ...adapt(file), closeAsync: async () => void closed.push(filename) } as ClosedProfileDb
    },
    ...over
  }
  return { deps, closed, opened }
}

const raws: DatabaseSync[] = []
async function made(identity: string | null) {
  const db = await walletDb(identity)
  raws.push(db.raw)
  return db
}
afterEach(() => {
  while (raws.length) raws.pop()!.close()
})

describe('the other databases of an identity', () => {
  it('is ok when there are none', async () => {
    const { deps } = fakeDeps({})
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: true })
    expect(await assertOtherNetworksEmpty(IDENTITY, deps)).toEqual({ ok: true })
  })

  it('is ok when every file holds nothing for the identity, and closes each one', async () => {
    const main = await made(IDENTITY)
    const test = await made(IDENTITY)
    const { deps, closed } = fakeDeps({ [MAIN_DB]: main.raw, [TEST_DB]: test.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: true })
    expect(closed).toEqual([MAIN_DB, TEST_DB])
  })

  it('blocks on spendable coins in a file the open wallet never reads, naming them as another network', async () => {
    const empty = await made(IDENTITY)
    const funded = await made(IDENTITY)
    addSpendable(funded.raw, funded.userId)
    const { deps } = fakeDeps({ [TEST_DB]: empty.raw, [MAIN_DB]: funded.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['spendable-outputs'] })
    expect(await assertOtherNetworksEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['other-network'] })
  })

  it('runs the same checks as the open one: an unfinished transaction, a queued payment, a received payment', async () => {
    const pending = await made(IDENTITY)
    pending.raw
      .prepare('INSERT INTO transactions (created_at, updated_at, userId, status, reference) VALUES (?, ?, ?, ?, ?)')
      .run(NOW, NOW, pending.userId, 'unproven', 'ref-p')
    const queued = await made(IDENTITY)
    queued.raw
      .prepare(
        `INSERT INTO offline_actions (created_at, updated_at, userId, txid, seq, role, status)
         VALUES (?, ?, ?, 'tx-1', 1, 'sent', 'queued')`
      )
      .run(NOW, NOW, queued.userId)
    const received = await made(IDENTITY)
    setKv(received.raw, PENDING_KEY, JSON.stringify([{ id: 'x', status: 'pending' }]))
    for (const [name, db] of [
      ['unproven', pending],
      ['queued', queued],
      ['received', received]
    ] as const) {
      const { deps } = fakeDeps({ [MAIN_DB]: db.raw })
      expect([name, await assertDatabasesEmpty(IDENTITY, deps)]).toEqual([
        name,
        { ok: false, reasons: [expect.any(String)] }
      ])
    }
  })

  it('reports each kind of thing once however many files hold it, and every kind it found', async () => {
    const a = await made(IDENTITY)
    const b = await made(IDENTITY)
    addSpendable(a.raw, a.userId)
    addSpendable(b.raw, b.userId)
    setKv(b.raw, PENDING_KEY, JSON.stringify([{ id: 'x', status: 'pending' }]))
    const { deps } = fakeDeps({ [MAIN_DB]: a.raw, [TEST_DB]: b.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({
      ok: false,
      reasons: ['spendable-outputs', 'localpay-pending']
    })
    expect(await assertOtherNetworksEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['other-network'] })
  })

  it('looks at this identity only: another identity’s coins in the same file are not this profile’s', async () => {
    const shared = await made(IDENTITY)
    const other = shared.raw
      .prepare('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)')
      .run(NOW, NOW, OTHER_IDENTITY)
    addSpendable(shared.raw, Number(other.lastInsertRowid))
    const { deps } = fakeDeps({ [MAIN_DB]: shared.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: true })
  })

  it('reads a file with no user for this identity as nothing', async () => {
    const stranger = await made(OTHER_IDENTITY)
    addSpendable(stranger.raw, stranger.userId)
    const { deps } = fakeDeps({ [MAIN_DB]: stranger.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: true })
  })

  it('reads a file that was never migrated as nothing: opening a registry entry whose file is gone creates one', async () => {
    const fresh = new DatabaseSync(':memory:')
    raws.push(fresh)
    const { deps, closed } = fakeDeps({ [MAIN_DB]: fresh })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: true })
    expect(closed).toEqual([MAIN_DB])
  })
})

describe('failing closed', () => {
  it('blocks when the registry cannot be read', async () => {
    const { deps } = fakeDeps(
      {},
      {
        list: async () => {
          throw new Error('storage unavailable')
        }
      }
    )
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['check-failed'] })
  })

  it('blocks when a file cannot be opened, and still looks into the others', async () => {
    const funded = await made(IDENTITY)
    addSpendable(funded.raw, funded.userId)
    const { deps, opened } = fakeDeps({ [MAIN_DB]: new Error('database is locked'), [TEST_DB]: funded.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({
      ok: false,
      reasons: ['check-failed', 'spendable-outputs']
    })
    expect(opened).toEqual([MAIN_DB, TEST_DB])
  })

  it('keeps check-failed as it is, rather than calling it another network', async () => {
    const { deps } = fakeDeps({ [MAIN_DB]: new Error('database is locked') })
    expect(await assertOtherNetworksEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['check-failed'] })
  })

  it('blocks on a file whose tables cannot all be read, never calling it empty', async () => {
    const damaged = await made(IDENTITY)
    damaged.raw.exec('DROP TABLE outputs')
    const { deps } = fakeDeps({ [MAIN_DB]: damaged.raw })
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['check-failed'] })
  })

  it('closes a file even when reading it threw, and a handle that will not close is not a failure', async () => {
    const damaged = await made(IDENTITY)
    damaged.raw.exec('DROP TABLE outputs')
    const healthy = await made(IDENTITY)
    const closed: string[] = []
    const deps: DatabasesEmptyDeps = {
      list: async () => [MAIN_DB, TEST_DB],
      open: async filename => {
        const raw = filename === MAIN_DB ? damaged.raw : healthy.raw
        return {
          ...adapt(raw),
          closeAsync: async () => {
            closed.push(filename)
            if (filename === TEST_DB) throw new Error('already closed')
          }
        } as ClosedProfileDb
      }
    }
    expect(await assertDatabasesEmpty(IDENTITY, deps)).toEqual({ ok: false, reasons: ['check-failed'] })
    expect(closed).toEqual([MAIN_DB, TEST_DB])
  })
})

describe('combineEmpty', () => {
  it('is ok only when every result is', () => {
    expect(combineEmpty()).toEqual({ ok: true })
    expect(combineEmpty({ ok: true }, { ok: true })).toEqual({ ok: true })
  })

  it('lists every reason once, in the order found', () => {
    expect(
      combineEmpty(
        { ok: false, reasons: ['spendable-outputs', 'offline-queue'] },
        { ok: true },
        { ok: false, reasons: ['offline-queue', 'other-network'] }
      )
    ).toEqual({ ok: false, reasons: ['spendable-outputs', 'offline-queue', 'other-network'] })
  })
})
