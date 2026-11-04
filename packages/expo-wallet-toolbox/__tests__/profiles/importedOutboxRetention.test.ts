import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import {
  assertDatabasesEmpty,
  assertOtherNetworksEmpty,
  assertProfileEmpty
} from '../../core/profiles/assertProfileEmpty'
import { OUTBOX_KEY, unsentEntries, type OutboxEntry } from '../../core/peerpay/outbox'

// Profile removal only needs this queue's key, not its native payment runtime.
jest.mock('../../core/localpay/pending', () => ({ PENDING_KEY: 'localpay_pending' }))

const IDENTITY = `02${'ab'.repeat(32)}`
const NOW = '2026-11-04T00:00:00.000Z'
let raw: DatabaseSync
let userId: number
function db() {
  return {
    execAsync: async (sql: string) => {
      raw.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as never[]))
  }
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(db() as never)
  userId = Number(
    raw.prepare('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)').run(NOW, NOW, IDENTITY)
      .lastInsertRowid
  )
  // A legacy already-broadcast payment can be completed with no owned output,
  // while its undelivered token still needs the outbox's retention protection.
  raw
    .prepare('INSERT INTO transactions (created_at, updated_at, userId, status, reference) VALUES (?, ?, ?, ?, ?)')
    .run(NOW, NOW, userId, 'completed', 'legacy-payment')
})
afterEach(() => raw.close())

test.each(['import_hold', 'future_status', undefined, 'sent'])(
  'only terminal sent history permits removal, including closed databases: %s',
  async status => {
    const entry = { id: 'legacy', status, token: { amount: 17 }, recipient: IDENTITY }
    raw
      .prepare('INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)')
      .run(OUTBOX_KEY, JSON.stringify([entry]), NOW)
    const storage = {
      sqliteDb: db(),
      getKeyValue: async (key: string) =>
        (raw.prepare('SELECT value FROM key_value_store WHERE key = ?').get(key) as { value: string } | undefined)
          ?.value
    }
    const expected = status === 'sent' ? { ok: true } : { ok: false, reasons: ['peerpay-outbox'] }
    await expect(
      assertProfileEmpty(storage, userId, {
        creditInbox: async () => ({ attention: 0, pending: false })
      })
    ).resolves.toEqual(expected)
    const closeAsync = jest.fn(async () => {})
    const deps = { list: async () => ['imported.db'], open: async () => ({ ...db(), closeAsync }) }
    await expect(assertDatabasesEmpty(IDENTITY, deps)).resolves.toEqual(expected)
    await expect(assertOtherNetworksEmpty(IDENTITY, deps)).resolves.toEqual(
      status === 'sent' ? { ok: true } : { ok: false, reasons: ['other-network'] }
    )
    expect(closeAsync).toHaveBeenCalledTimes(2)
    expect(unsentEntries([entry as OutboxEntry])).toEqual([])
  }
)
