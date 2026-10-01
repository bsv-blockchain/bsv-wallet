/**
 * The zero-balance proof that gates removing a profile, run against REAL SQLite.
 *
 * node:sqlite stands the same `createTables()` schema up that the app runs on
 * device, so a table or column this module reads under the wrong name fails
 * here — as `check-failed`, which is exactly what the app would answer — rather
 * than as a profile that could never be removed. The key_value_store reads go
 * through the real table for the same reason.
 *
 * The invariant under test is one-directional: nothing may make this answer
 * `ok` unless every blocker was actually checked and found clear.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import {
  assertProfileEmpty,
  type AssertProfileEmptyDeps,
  type ProfileEmptyStorage,
  type RemovalBlocker
} from '../../core/profiles/assertProfileEmpty'
import { PENDING_JOURNAL_KEY } from '../../core/identity/handleRegistry/registration'
import { OUTBOX_KEY } from '../../core/peerpay/outbox'
import { PENDING_KEY } from '../../core/localpay/pending'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

/**
 * Compile-time only: the real storage is what removal will hand in, and the
 * structural type above must keep accepting it — a drift would otherwise
 * surface as a type error in the flow, far from the check that caused it.
 */
export const realStorageFits = (storage: StorageExpoSQLite): ProfileEmptyStorage => storage

/** expo-sqlite's async surface over node:sqlite's sync one. */
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

const NOW = '2026-10-01T00:00:00.000Z'
const IDENTITY = '02' + 'ab'.repeat(32)
const OTHER_IDENTITY = '03' + 'cd'.repeat(32)
const OVERLAY_KEY = '02' + 'ef'.repeat(32)

let raw: DatabaseSync
let userId: number
let otherUserId: number
let txCounter = 0

function addUser(identityKey: string): number {
  const r = raw
    .prepare('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)')
    .run(NOW, NOW, identityKey)
  return Number(r.lastInsertRowid)
}

function addTransaction(user: number, status: string): number {
  txCounter += 1
  const r = raw
    .prepare('INSERT INTO transactions (created_at, updated_at, userId, status, reference) VALUES (?, ?, ?, ?, ?)')
    .run(NOW, NOW, user, status, `ref-${txCounter}`)
  return Number(r.lastInsertRowid)
}

function addBasket(user: number, name: string): number {
  const r = raw
    .prepare('INSERT INTO output_baskets (created_at, updated_at, userId, name) VALUES (?, ?, ?, ?)')
    .run(NOW, NOW, user, name)
  return Number(r.lastInsertRowid)
}

function addOutput(args: { user: number; transactionId: number; spendable: 0 | 1; basketId?: number }): void {
  txCounter += 1
  raw
    .prepare(
      `INSERT INTO outputs (created_at, updated_at, userId, transactionId, basketId, spendable, vout, satoshis, providedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'you')`
    )
    .run(NOW, NOW, args.user, args.transactionId, args.basketId ?? null, args.spendable, txCounter, 1000)
}

function addOfflineAction(user: number, status: string): void {
  txCounter += 1
  raw
    .prepare(
      `INSERT INTO offline_actions (created_at, updated_at, userId, txid, seq, role, status)
       VALUES (?, ?, ?, ?, ?, 'sent', ?)`
    )
    .run(NOW, NOW, user, `tx-${txCounter}`, txCounter, status)
}

function addSettlement(state: string): void {
  txCounter += 1
  raw
    .prepare(
      `INSERT INTO token_settlements (txid, role, assetId, state, overlayUrl, overlayIdentityKey, createdAt, updatedAt)
       VALUES (?, 'received', 'asset.0', ?, 'https://overlay.example', ?, ?, ?)`
    )
    .run(`settle-${txCounter}`, state, OVERLAY_KEY, NOW, NOW)
}

function setKv(key: string, value: string): void {
  raw
    .prepare(
      `INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value, NOW)
}

function kvKeys(): string[] {
  return (raw.prepare('SELECT key FROM key_value_store ORDER BY key').all() as { key: string }[]).map(r => r.key)
}

function storageOf(db: DatabaseSync): ProfileEmptyStorage {
  return {
    sqliteDb: adapt(db) as never,
    async getKeyValue(key) {
      return (db.prepare('SELECT value FROM key_value_store WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value
    }
  }
}

const CLEAN_INBOX = async () => ({ attention: 0, pending: false })
const deps = (over: Partial<AssertProfileEmptyDeps> = {}): AssertProfileEmptyDeps => ({
  creditInbox: CLEAN_INBOX,
  ...over
})

const reasonsOf = async (over: Partial<AssertProfileEmptyDeps> = {}, storage = storageOf(raw)) => {
  const result = await assertProfileEmpty(storage, userId, deps(over))
  return result.ok ? 'ok' : result.reasons
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  userId = addUser(IDENTITY)
  otherUserId = addUser(OTHER_IDENTITY)
  txCounter = 0
})

afterEach(() => raw.close())

describe('a profile with nothing in it', () => {
  it('is ok', async () => {
    expect(await assertProfileEmpty(storageOf(raw), userId, deps())).toEqual({ ok: true })
  })

  it('is still ok with every kind of finished business left behind', async () => {
    const done = addTransaction(userId, 'completed')
    addTransaction(userId, 'failed')
    addOutput({ user: userId, transactionId: done, spendable: 0 })
    for (const status of ['sent', 'rejected', 'acknowledged']) addOfflineAction(userId, status)
    for (const state of ['broadcast', 'admitted', 'refused', 'orphaned']) addSettlement(state)
    setKv(PENDING_KEY, '[]')
    setKv(PENDING_JOURNAL_KEY, '')
    setKv(
      OUTBOX_KEY,
      JSON.stringify([{ id: 'a', status: 'sent', createdAt: NOW, recipient: IDENTITY, token: {}, messageBoxUrl: '' }])
    )
    expect(
      await reasonsOf({
        mandalaBalances: async () => [
          { baseUnits: 0, unsettledBaseUnits: 0 },
          { baseUnits: 0, unsettledBaseUnits: 0 }
        ]
      })
    ).toBe('ok')
  })

  it('treats a queue holding only completed entries as empty', async () => {
    setKv(PENDING_KEY, JSON.stringify([{ id: 'x', status: 'completed' }]))
    expect(await reasonsOf()).toBe('ok')
  })
})

describe('spendable outputs', () => {
  it('blocks on a spendable output in the default basket', async () => {
    const tx = addTransaction(userId, 'completed')
    addOutput({ user: userId, transactionId: tx, spendable: 1, basketId: addBasket(userId, 'default') })
    expect(await reasonsOf()).toEqual(['spendable-outputs'])
  })

  it('blocks on a spendable output in any other basket — a token coin is one', async () => {
    const tx = addTransaction(userId, 'completed')
    addOutput({ user: userId, transactionId: tx, spendable: 1, basketId: addBasket(userId, 'mandala-tokens') })
    expect(await reasonsOf()).toEqual(['spendable-outputs'])
  })

  it('blocks on a spendable output that sits in no basket at all', async () => {
    const tx = addTransaction(userId, 'completed')
    addOutput({ user: userId, transactionId: tx, spendable: 1 })
    expect(await reasonsOf()).toEqual(['spendable-outputs'])
  })

  it('does not block on an output that has been spent', async () => {
    const tx = addTransaction(userId, 'completed')
    addOutput({ user: userId, transactionId: tx, spendable: 0, basketId: addBasket(userId, 'default') })
    expect(await reasonsOf()).toBe('ok')
  })

  it('looks at this user only', async () => {
    const tx = addTransaction(otherUserId, 'completed')
    addOutput({ user: otherUserId, transactionId: tx, spendable: 1 })
    expect(await reasonsOf()).toBe('ok')
  })
})

describe('unfinished transactions', () => {
  it.each(['unprocessed', 'unsigned', 'nosend', 'sending', 'nonfinal', 'unproven'])(
    'blocks on a %s one',
    async status => {
      addTransaction(userId, status)
      expect(await reasonsOf()).toEqual(['pending-transactions'])
    }
  )

  it('blocks on a status it has never heard of rather than assuming it is finished', async () => {
    addTransaction(userId, 'something-new')
    expect(await reasonsOf()).toEqual(['pending-transactions'])
  })

  it('looks at this user only', async () => {
    addTransaction(otherUserId, 'unproven')
    expect(await reasonsOf()).toBe('ok')
  })
})

describe('the offline queue', () => {
  it.each(['queued', 'posting', 'parked', 'import_hold'])('blocks on a %s row', async status => {
    addOfflineAction(userId, status)
    expect(await reasonsOf()).toEqual(['offline-queue'])
  })

  it('blocks on a status it has never heard of rather than assuming it is finished', async () => {
    addOfflineAction(userId, 'something-new')
    expect(await reasonsOf()).toEqual(['offline-queue'])
  })

  it('looks at this user only', async () => {
    addOfflineAction(otherUserId, 'queued')
    expect(await reasonsOf()).toBe('ok')
  })
})

describe('token settlements and balances', () => {
  it.each(['built', 'parked', 'handed_over', 'held', 'submitting'])('blocks on a settlement still %s', async state => {
    addSettlement(state)
    expect(await reasonsOf()).toEqual(['token-settlements'])
  })

  it('blocks on a token balance', async () => {
    expect(await reasonsOf({ mandalaBalances: async () => [{ baseUnits: 5, unsettledBaseUnits: 0 }] })).toEqual([
      'token-balance'
    ])
  })

  it('blocks on an unsettled token balance', async () => {
    expect(await reasonsOf({ mandalaBalances: async () => [{ baseUnits: 0, unsettledBaseUnits: 1 }] })).toEqual([
      'token-balance'
    ])
  })

  it('blocks on one non-zero asset among zeros', async () => {
    expect(
      await reasonsOf({
        mandalaBalances: async () => [
          { baseUnits: 0, unsettledBaseUnits: 0 },
          { baseUnits: 0, unsettledBaseUnits: 3 }
        ]
      })
    ).toEqual(['token-balance'])
  })

  it('does not read a figure that is not a number as zero', async () => {
    expect(await reasonsOf({ mandalaBalances: async () => [{ baseUnits: NaN, unsettledBaseUnits: 0 }] })).toEqual([
      'token-balance'
    ])
  })

  it('needs no runtime: without one the SQL checks stand on their own', async () => {
    expect(await reasonsOf({ mandalaBalances: undefined })).toBe('ok')
  })
})

describe('received payments waiting to be credited', () => {
  const entry = (over: Record<string, unknown>) => ({ id: 'p1', receivedAt: NOW, frame: {}, ...over })

  it.each([
    ['pending', { status: 'pending' }],
    ['processing', { status: 'processing' }],
    ['stuck', { status: 'failed', attempts: 3 }],
    ['failed', { status: 'failed', attempts: 1 }]
  ])('blocks on a %s entry', async (_name, over) => {
    setKv(PENDING_KEY, JSON.stringify([entry(over)]))
    expect(await reasonsOf()).toEqual(['localpay-pending'])
  })

  it('blocks on a queue that is not JSON — corrupt is not empty', async () => {
    setKv(PENDING_KEY, '{not json')
    expect(await reasonsOf()).toEqual(['localpay-pending'])
  })

  it('blocks on a queue that is JSON but not a list', async () => {
    setKv(PENDING_KEY, '{"status":"pending"}')
    expect(await reasonsOf()).toEqual(['localpay-pending'])
  })

  it('blocks on an entry that is not an object', async () => {
    setKv(PENDING_KEY, '[null]')
    expect(await reasonsOf()).toEqual(['localpay-pending'])
  })

  /**
   * Reading the queue repairs a corrupt one — the blob is copied to a
   * timestamped key and the live key is reset to `[]` — so by the time anyone
   * taps Remove, that copy is the only durable trace of the payments that could
   * not be parsed. Removing the profile would delete it.
   */
  it('blocks on a quarantined copy of a corrupt queue, though the live queue was repaired', async () => {
    setKv(PENDING_KEY, '[]')
    setKv('localpay_pending_corrupt_1790000000000', '{not json')
    expect(await reasonsOf()).toEqual(['localpay-pending'])
  })

  it('is not fooled by the summary row sitting beside the queue', async () => {
    setKv('localpay_pending_summary', JSON.stringify({ waiting: 0, stuck: 0 }))
    expect(await reasonsOf()).toBe('ok')
  })

  it('does not touch the queue to find out — a corrupt one is left exactly as it was', async () => {
    setKv(PENDING_KEY, '{not json')
    const before = kvKeys()
    await reasonsOf()
    expect(kvKeys()).toEqual(before)
    expect(
      (raw.prepare('SELECT value FROM key_value_store WHERE key = ?').get(PENDING_KEY) as { value: string }).value
    ).toBe('{not json')
  })
})

describe('outgoing payments not yet delivered', () => {
  const sent = { id: 's', status: 'sent', createdAt: NOW, recipient: IDENTITY, token: {}, messageBoxUrl: '' }
  const unsent = { ...sent, id: 'u', status: 'unsent' }

  it('blocks on an entry that is not sent', async () => {
    setKv(OUTBOX_KEY, JSON.stringify([sent, unsent]))
    expect(await reasonsOf()).toEqual(['peerpay-outbox'])
  })

  it('does not block on sent entries kept as a copy', async () => {
    setKv(OUTBOX_KEY, JSON.stringify([sent]))
    expect(await reasonsOf()).toBe('ok')
  })

  it('fails closed on an outbox it cannot read, rather than reading it as empty', async () => {
    setKv(OUTBOX_KEY, '{not json')
    expect(await reasonsOf()).toEqual(['check-failed'])
  })

  it('fails closed on an outbox that is not a list', async () => {
    setKv(OUTBOX_KEY, '{"status":"unsent"}')
    expect(await reasonsOf()).toEqual(['check-failed'])
  })
})

describe('an unfinished handle write', () => {
  it('blocks on a journal', async () => {
    setKv(PENDING_JOURNAL_KEY, JSON.stringify({ v: 1, intent: 'release', steps: [{}], startedAt: NOW }))
    expect(await reasonsOf()).toEqual(['handle-journal'])
  })

  it('blocks on any non-empty value rather than judging whether it could be finished', async () => {
    setKv(PENDING_JOURNAL_KEY, 'x')
    expect(await reasonsOf()).toEqual(['handle-journal'])
  })

  it('does not block on the empty string a cleared journal leaves behind', async () => {
    setKv(PENDING_JOURNAL_KEY, '')
    expect(await reasonsOf()).toBe('ok')
  })
})

describe('the inbox', () => {
  it('blocks while a payment in it is still waiting to be credited', async () => {
    expect(await reasonsOf({ creditInbox: async () => ({ attention: 0, pending: true }) })).toEqual(['inbox-pending'])
  })

  it('blocks on a payment it could not credit and gave up on', async () => {
    expect(await reasonsOf({ creditInbox: async () => ({ attention: 2, pending: false }) })).toEqual(['inbox-pending'])
  })

  it('runs its pass once, and BEFORE it reads the database', async () => {
    const credit = jest.fn(async () => {
      // What the pass credits has to be visible to the checks that follow it.
      addOutput({ user: userId, transactionId: addTransaction(userId, 'completed'), spendable: 1 })
      return { attention: 0, pending: false }
    })
    expect(await reasonsOf({ creditInbox: credit })).toEqual(['spendable-outputs'])
    expect(credit).toHaveBeenCalledTimes(1)
  })

  it('still reads the database when the pass fails, so the user hears about the funds too', async () => {
    addTransaction(userId, 'unproven')
    expect(
      await reasonsOf({
        creditInbox: async () => {
          throw new Error('offline')
        }
      })
    ).toEqual(['check-failed', 'pending-transactions'])
  })
})

describe('failing closed', () => {
  it('is not ok when the database is closed', async () => {
    const closed: ProfileEmptyStorage = { sqliteDb: undefined, getKeyValue: async () => undefined }
    const result = await assertProfileEmpty(closed, userId, deps())
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.reasons).toContain('check-failed')
  })

  it('is not ok when a query throws', async () => {
    const storage: ProfileEmptyStorage = {
      ...storageOf(raw),
      sqliteDb: {
        getFirstAsync: async () => {
          throw new Error('database is locked')
        }
      } as never
    }
    expect(await reasonsOf({}, storage)).toEqual(['check-failed'])
  })

  it('is not ok when a table it reads is missing', async () => {
    raw.exec('DROP TABLE token_settlements')
    expect(await reasonsOf()).toEqual(['check-failed'])
  })

  it('is not ok when the key-value store cannot be read', async () => {
    const storage: ProfileEmptyStorage = {
      ...storageOf(raw),
      getKeyValue: async () => {
        throw new Error('boom')
      }
    }
    expect(await reasonsOf({}, storage)).toEqual(['check-failed'])
  })

  it('is not ok when the inbox pass throws', async () => {
    expect(
      await reasonsOf({
        creditInbox: async () => {
          throw new Error('no network')
        }
      })
    ).toEqual(['check-failed'])
  })

  it('is not ok when the inbox pass answers nothing at all', async () => {
    expect(await reasonsOf({ creditInbox: (async () => undefined) as never })).toEqual(['check-failed'])
  })

  it('is not ok when the token balances cannot be read', async () => {
    expect(
      await reasonsOf({
        mandalaBalances: async () => {
          throw new Error('overlay unreachable')
        }
      })
    ).toEqual(['check-failed'])
  })

  it.each([0, -1, 1.5, NaN, undefined as unknown as number])('is not ok for the user id %p', async id => {
    const result = await assertProfileEmpty(storageOf(raw), id, deps())
    expect(result).toEqual({ ok: false, reasons: ['check-failed'] })
  })
})

describe('reporting', () => {
  it('names every blocker it found, once each, in a stable order', async () => {
    const tx = addTransaction(userId, 'unproven')
    addOutput({ user: userId, transactionId: tx, spendable: 1 })
    addOfflineAction(userId, 'queued')
    addSettlement('held')
    setKv(PENDING_KEY, JSON.stringify([{ id: 'p', status: 'pending' }]))
    setKv(OUTBOX_KEY, JSON.stringify([{ id: 'u', status: 'unsent' }]))
    setKv(PENDING_JOURNAL_KEY, '{"v":1}')
    const expected: RemovalBlocker[] = [
      'inbox-pending',
      'spendable-outputs',
      'pending-transactions',
      'offline-queue',
      'token-settlements',
      'token-balance',
      'localpay-pending',
      'peerpay-outbox',
      'handle-journal'
    ]
    expect(
      await reasonsOf({
        creditInbox: async () => ({ attention: 1, pending: true }),
        mandalaBalances: async () => [{ baseUnits: 1, unsettledBaseUnits: 1 }]
      })
    ).toEqual(expected)
  })

  it('collapses several failures into one check-failed', async () => {
    raw.exec('DROP TABLE outputs; DROP TABLE transactions; DROP TABLE offline_actions;')
    expect(await reasonsOf()).toEqual(['check-failed'])
  })
})
