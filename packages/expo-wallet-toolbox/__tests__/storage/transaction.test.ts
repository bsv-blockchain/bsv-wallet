/**
 * Connection discipline for StorageExpoSQLite.transaction().
 *
 * expo-sqlite's withExclusiveTransactionAsync opens a second connection and
 * CLOSES it when the scope ends. The old implementation swapped `this.db` to
 * that connection for the scope's duration, so any concurrent caller — a
 * monitor task, a balance refresh, a raw `sqliteDb` user — prepared statements
 * on a connection that was about to be closed under it. On Android that is a
 * SIGSEGV in exsqlite3_reset (two crash dumps, 2026-09-02). These tests pin the
 * rule that replaced the swap: the transaction connection is reachable ONLY
 * through the token, and everything else stays on the main connection.
 */
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import type { TrxToken } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'

const NOW = '2026-09-02T00:00:00.000Z'

class FakeConn {
  closed = false
  log: string[] = []
  constructor(public readonly name: string) {}
  private use(sql: string): void {
    if (this.closed) throw new Error(`${this.name}: statement on a closed connection`)
    this.log.push(sql)
  }
  async execAsync(sql: string): Promise<void> {
    this.use(sql)
  }
  async runAsync(sql: string, _params: unknown[] = []): Promise<{ lastInsertRowId: number; changes: number }> {
    this.use(sql)
    return { lastInsertRowId: 1, changes: 1 }
  }
  async getAllAsync(sql: string, _params: unknown[] = []): Promise<unknown[]> {
    this.use(sql)
    return []
  }
  async getFirstAsync(sql: string, _params: unknown[] = []): Promise<unknown> {
    this.use(sql)
    if (/FROM settings/.test(sql)) {
      return {
        storageIdentityKey: 'key',
        storageName: 'name',
        chain: 'test',
        dbtype: 'SQLite',
        maxOutputScript: 1024,
        created_at: NOW,
        updated_at: NOW
      }
    }
    return null
  }
}

/** Mirrors expo-sqlite: a fresh connection per exclusive transaction, closed in `finally`. */
class FakeMain extends FakeConn {
  txns: FakeConn[] = []
  async withExclusiveTransactionAsync(task: (txn: FakeConn) => Promise<void>): Promise<void> {
    const txn = new FakeConn(`txn${this.txns.length + 1}`)
    this.txns.push(txn)
    let error: unknown
    try {
      await txn.execAsync('BEGIN')
      await task(txn)
      await txn.execAsync('COMMIT')
    } catch (e) {
      await txn.execAsync('ROLLBACK')
      error = e
    } finally {
      txn.closed = true
    }
    if (error) throw error
  }
}

class TestStorage extends StorageExpoSQLite {
  constructor(public readonly main: FakeMain) {
    super({ chain: 'test' } as never)
  }
  protected async openDatabase(): Promise<never> {
    return this.main as never
  }
}

const event = () => ({ id: 0, created_at: new Date(NOW), updated_at: new Date(NOW), event: 'e', details: 'd' })
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

let main: FakeMain
let storage: TestStorage

beforeEach(() => {
  main = new FakeMain('main')
  storage = new TestStorage(main)
  ;(storage as unknown as { db: unknown }).db = main
  ;(storage as unknown as { _settings: unknown })._settings = { dbtype: 'SQLite' }
})

describe('transaction()', () => {
  it('routes token-carrying statements to the transaction connection and everything else to main', async () => {
    let started!: () => void
    const scopeStarted = new Promise<void>(r => (started = r))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))

    const done = storage.transaction(async trx => {
      await storage.insertMonitorEvent(event() as never, trx)
      started()
      await gate
    })
    await scopeStarted

    // A concurrent caller with no token — exactly what a monitor task or a
    // screen refresh looks like while a payment is being written.
    await storage.getKeyValue('k')

    release()
    await done

    expect(main.txns).toHaveLength(1)
    const txn = main.txns[0]
    expect(txn.log.some(s => /INSERT INTO "monitor_events"/.test(s))).toBe(true)
    expect(txn.log.some(s => /key_value_store/.test(s))).toBe(false)
    expect(main.log.some(s => /key_value_store/.test(s))).toBe(true)
    expect(main.log.some(s => /monitor_events/.test(s))).toBe(false)
  })

  it('keeps sqliteDb pointing at the main connection while a transaction is open', async () => {
    let seen: unknown
    await storage.transaction(async () => {
      seen = storage.sqliteDb
    })
    expect(seen).toBe(main)
  })

  it('sets a busy timeout on the fresh transaction connection before the scope runs', async () => {
    await storage.transaction(async trx => {
      await storage.insertMonitorEvent(event() as never, trx)
    })
    const log = main.txns[0].log
    const pragmaAt = log.findIndex(s => /PRAGMA busy_timeout/.test(s))
    const insertAt = log.findIndex(s => /INSERT/.test(s))
    expect(pragmaAt).toBeGreaterThan(-1)
    expect(pragmaAt).toBeLessThan(insertAt)
  })

  it('serialises concurrent transactions instead of nesting connections', async () => {
    const order: string[] = []
    const a = storage.transaction(async () => {
      order.push('a-start')
      await sleep(10)
      order.push('a-end')
    })
    const b = storage.transaction(async () => {
      order.push('b-start')
      order.push('b-end')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    expect(main.txns).toHaveLength(2)
    expect(main.txns[0].log).toContain('COMMIT')
    expect(main.txns[1].log).toContain('COMMIT')
  })

  it('reuses the token for a nested call rather than opening a second connection', async () => {
    let inner: TrxToken | undefined
    let outer: TrxToken | undefined
    await storage.transaction(async trx => {
      outer = trx
      await storage.transaction(async t => {
        inner = t
      }, trx)
    })
    expect(inner).toBe(outer)
    expect(main.txns).toHaveLength(1)
  })

  it('rolls back and rethrows when the scope throws', async () => {
    await expect(
      storage.transaction(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(main.txns[0].log).toContain('ROLLBACK')
  })

  it('fails loudly instead of hanging when the lock is never released', async () => {
    storage.transactionLockTimeoutMs = 20
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const holder = storage.transaction(async () => {
      await gate
    })
    await expect(storage.transaction(async () => undefined)).rejects.toThrow(/transaction lock/i)
    release()
    await holder
  })
})

describe('migrate()', () => {
  it('enables WAL and a busy timeout on the main connection before anything else runs', async () => {
    const fresh = new FakeMain('main')
    const s = new TestStorage(fresh)
    await s.migrate('name', 'key')
    expect(fresh.log[0]).toMatch(/PRAGMA journal_mode\s*=\s*WAL/i)
    expect(fresh.log[1]).toMatch(/PRAGMA busy_timeout\s*=\s*\d+/i)
  })
})

describe('checkpointWal()', () => {
  it('folds the WAL back into the main file so a raw copy of the .db is complete', async () => {
    await storage.checkpointWal()
    expect(main.log).toEqual([expect.stringMatching(/PRAGMA wal_checkpoint\(TRUNCATE\)/i)])
  })
})
