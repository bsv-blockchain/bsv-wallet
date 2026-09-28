/**
 * The guard's point lookups, run against the REAL schema on node:sqlite — the
 * same SQL StorageExpoSQLite runs on device.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

function adapt(db: DatabaseSync, seen: string[] = []) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT 1 AS hit')) seen.push(sql)
      return db.prepare(sql).get(...(params as never[])) ?? null
    },
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

const NOW = '2026-09-27T00:00:00.000Z'
let raw: DatabaseSync
let db: ReturnType<typeof adapt>
let statements: string[]
let storage: StorageExpoSQLite
let refs = 0

const txidOf = (n: number) => n.toString(16).padStart(64, '0')

async function lastId(table: string, column: string): Promise<number> {
  const row = (await db.getFirstAsync(`SELECT MAX(${column}) AS id FROM ${table}`, [])) as { id: number }
  return row.id
}

async function seedBasket(name: string): Promise<number> {
  await db.runAsync(
    `INSERT INTO output_baskets (created_at, updated_at, userId, name, numberOfDesiredUTXOs, minimumDesiredUTXOValue)
     VALUES (?, ?, 1, ?, 6, 1000)`,
    [NOW, NOW, name]
  )
  return await lastId('output_baskets', 'basketId')
}

async function seedTransaction(txid: string, labels: string[] = []): Promise<number> {
  await db.runAsync(
    `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
     VALUES (?, ?, 1, 'nosend', ?, 1, 0, ?)`,
    [NOW, NOW, `ref-${refs++}`, txid]
  )
  const transactionId = await lastId('transactions', 'transactionId')
  for (const label of labels) {
    await db.runAsync(`INSERT OR IGNORE INTO tx_labels (created_at, updated_at, userId, label) VALUES (?, ?, 1, ?)`, [
      NOW,
      NOW,
      label
    ])
    const { txLabelId } = (await db.getFirstAsync('SELECT txLabelId FROM tx_labels WHERE label = ?', [label])) as {
      txLabelId: number
    }
    await db.runAsync(
      `INSERT INTO tx_labels_map (created_at, updated_at, txLabelId, transactionId) VALUES (?, ?, ?, ?)`,
      [NOW, NOW, txLabelId, transactionId]
    )
  }
  return transactionId
}

async function seedOutput(opts: {
  transactionId: number
  txid: string
  vout: number
  basketId: number | null
  spentBy?: number
  tags?: string[]
}): Promise<number> {
  await db.runAsync(
    `INSERT INTO outputs (created_at, updated_at, userId, transactionId, basketId, spendable, change,
       vout, satoshis, providedBy, txid, lockingScript, spentBy)
     VALUES (?, ?, 1, ?, ?, 1, 0, ?, 1000, 'you', ?, ?, ?)`,
    [NOW, NOW, opts.transactionId, opts.basketId, opts.vout, opts.txid, new Uint8Array(25), opts.spentBy ?? null]
  )
  const outputId = await lastId('outputs', 'outputId')
  for (const tag of opts.tags ?? []) {
    await db.runAsync(`INSERT OR IGNORE INTO output_tags (created_at, updated_at, userId, tag) VALUES (?, ?, 1, ?)`, [
      NOW,
      NOW,
      tag
    ])
    const { outputTagId } = (await db.getFirstAsync('SELECT outputTagId FROM output_tags WHERE tag = ?', [tag])) as {
      outputTagId: number
    }
    await db.runAsync(
      `INSERT INTO output_tags_map (created_at, updated_at, outputTagId, outputId) VALUES (?, ?, ?, ?)`,
      [NOW, NOW, outputTagId, outputId]
    )
  }
  return outputId
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  statements = []
  db = adapt(raw, statements)
  await createTables(db as never)
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  ;(storage as unknown as { db: unknown }).db = db
  await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
    NOW,
    NOW,
    '02' + 'a'.repeat(62)
  ])
})

afterEach(() => {
  raw.close()
})

describe('anyAdminOutpoint', () => {
  it('hits only an outpoint stored in an admin-prefixed basket', async () => {
    const vault = await seedBasket('admin vault')
    const general = await seedBasket('general')
    const dflt = await seedBasket('default')
    const tx = await seedTransaction(txidOf(1))
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 0, basketId: vault })
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 1, basketId: general })
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 2, basketId: dflt })
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 3, basketId: null })

    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.0`])).resolves.toBe(true)
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.1`])).resolves.toBe(false)
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.2`])).resolves.toBe(false)
    // Relinquished, and nothing marks it as Vault/admin state: an app's own.
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.3`])).resolves.toBe(false)
    await expect(storage.anyAdminOutpoint([`${txidOf(2)}.0`])).resolves.toBe(false)
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.1`, `${txidOf(1)}.0`])).resolves.toBe(true)
    await expect(storage.anyAdminOutpoint([`${txidOf(1).toUpperCase()}.0`])).resolves.toBe(true)
  })

  // "Forget unreachable deposits" relinquishes a Vault output: basketId goes
  // NULL but the coins stay on chain. Its `vault` tag (deposits, re-locks and
  // chain recovery all set it) or its transaction's `vault` label still mark it.
  it('keeps a relinquished Vault output protected through its tag or its transaction label', async () => {
    const recovered = await seedTransaction(txidOf(1))
    await seedOutput({ transactionId: recovered, txid: txidOf(1), vout: 0, basketId: null, tags: ['vault'] })
    const deposit = await seedTransaction(txidOf(2), ['vault', 'vault-deposit'])
    await seedOutput({ transactionId: deposit, txid: txidOf(2), vout: 0, basketId: null })
    const adminTx = await seedTransaction(txidOf(3), ['admin export'])
    await seedOutput({ transactionId: adminTx, txid: txidOf(3), vout: 0, basketId: null })

    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.0`])).resolves.toBe(true)
    await expect(storage.anyAdminOutpoint([`${txidOf(2)}.0`])).resolves.toBe(true)
    await expect(storage.anyAdminOutpoint([`${txidOf(3)}.0`])).resolves.toBe(true)
  })

  // `vault` is not a reserved label or tag, so a third-party app may use it.
  // It only counts once the wallet has relinquished the row.
  it('ignores a vault tag or label on an output still held in an ordinary basket', async () => {
    const general = await seedBasket('general')
    const tx = await seedTransaction(txidOf(1), ['vault'])
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 0, basketId: general, tags: ['vault'] })
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.0`])).resolves.toBe(false)
  })

  it('matches the admin prefix exactly, not a basket merely containing it', async () => {
    const lookalike = await seedBasket('my admin vault')
    const tx = await seedTransaction(txidOf(1))
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 0, basketId: lookalike })
    await expect(storage.anyAdminOutpoint([`${txidOf(1)}.0`])).resolves.toBe(false)
  })

  it('splits a large request across statements and still finds a late hit', async () => {
    const vault = await seedBasket('admin vault')
    const tx = await seedTransaction(txidOf(1))
    await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 700, basketId: vault })
    const outpoints = Array.from({ length: 701 }, (_, vout) => `${txidOf(1)}.${vout}`)
    await expect(storage.anyAdminOutpoint(outpoints)).resolves.toBe(true)
    expect(statements.length).toBe(2)
  })

  it('rejects a malformed outpoint instead of guessing', async () => {
    await expect(storage.anyAdminOutpoint(['not-an-outpoint'])).rejects.toThrow(/Invalid outpoint/)
  })
})

describe('anyAdminTransaction', () => {
  it('hits a transaction that creates or spends an admin-basket output, or carries a vault/admin label', async () => {
    const vault = await seedBasket('admin vault')
    const dflt = await seedBasket('default')

    const deposit = await seedTransaction(txidOf(1))
    await seedOutput({ transactionId: deposit, txid: txidOf(1), vout: 0, basketId: vault })

    // A signed-but-held withdrawal: no admin output, no label, but it has
    // reserved the Vault output as an input (spentBy).
    const withdraw = await seedTransaction(txidOf(2))
    await seedOutput({ transactionId: withdraw, txid: txidOf(2), vout: 0, basketId: dflt })
    const funding = await seedTransaction(txidOf(3))
    await seedOutput({ transactionId: funding, txid: txidOf(3), vout: 0, basketId: vault, spentBy: withdraw })

    await seedTransaction(txidOf(4), ['vault', 'vault-relock'])
    await seedTransaction(txidOf(5), ['admin export'])

    const ordinary = await seedTransaction(txidOf(6), ['payment'])
    await seedOutput({ transactionId: ordinary, txid: txidOf(6), vout: 0, basketId: dflt })

    await expect(storage.anyAdminTransaction([txidOf(1)])).resolves.toBe(true)
    await expect(storage.anyAdminTransaction([txidOf(2)])).resolves.toBe(true)
    await expect(storage.anyAdminTransaction([txidOf(4)])).resolves.toBe(true)
    await expect(storage.anyAdminTransaction([txidOf(5)])).resolves.toBe(true)
    await expect(storage.anyAdminTransaction([txidOf(6)])).resolves.toBe(false)
    await expect(storage.anyAdminTransaction([txidOf(99)])).resolves.toBe(false)
    await expect(storage.anyAdminTransaction([txidOf(6), txidOf(2).toUpperCase()])).resolves.toBe(true)
  })

  it('does not treat a lookalike label as a vault label', async () => {
    await seedTransaction(txidOf(1), ['vaulted', 'my vault'])
    await expect(storage.anyAdminTransaction([txidOf(1)])).resolves.toBe(false)
  })

  it('splits a large request across statements and still finds a late hit', async () => {
    await seedTransaction(txidOf(1000), ['vault'])
    const txids = Array.from({ length: 1001 }, (_, i) => txidOf(i))
    await expect(storage.anyAdminTransaction(txids)).resolves.toBe(true)
    expect(statements.length).toBe(2)
  })

  it('rejects a malformed txid instead of guessing', async () => {
    await expect(storage.anyAdminTransaction(['zz'])).rejects.toThrow(/Invalid txid/)
  })
})

describe('validateResolvedActionInput (the createAction input backstop)', () => {
  it('refuses a non-admin input that is admin state, and lets the admin originator through', async () => {
    const vault = await seedBasket('admin vault')
    const tx = await seedTransaction(txidOf(1))
    const inBasket = await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 0, basketId: vault })
    const relinquished = await seedOutput({
      transactionId: tx,
      txid: txidOf(1),
      vout: 1,
      basketId: null,
      tags: ['vault']
    })

    for (const outputId of [inBasket, relinquished]) {
      await expect(
        storage.validateResolvedActionInput({ __bsvVaultAdminAuthorized: false }, { output: { outputId } })
      ).rejects.toThrow(/internal wallet authorization/i)
      await expect(storage.validateResolvedActionInput({}, { output: { outputId } })).rejects.toThrow(
        /internal wallet authorization/i
      )
      await expect(
        storage.validateResolvedActionInput({ __bsvVaultAdminAuthorized: true }, { output: { outputId } })
      ).resolves.toBeUndefined()
    }
  })

  // The basket decides, not the script: an app may spend its own R1C outputs.
  it('lets any originator spend an output held in an ordinary basket, and skips BEEF-only sources', async () => {
    const general = await seedBasket('my app r1c')
    const tx = await seedTransaction(txidOf(1))
    const outputId = await seedOutput({ transactionId: tx, txid: txidOf(1), vout: 0, basketId: general })
    await expect(
      storage.validateResolvedActionInput({ __bsvVaultAdminAuthorized: false }, { output: { outputId } })
    ).resolves.toBeUndefined()
    const before = statements.length
    await expect(storage.validateResolvedActionInput({ __bsvVaultAdminAuthorized: false }, {})).resolves.toBeUndefined()
    expect(statements.length).toBe(before)
  })
})

test('no lookup reads a locking script', async () => {
  await storage.anyAdminOutpoint([`${txidOf(1)}.0`])
  await storage.anyAdminTransaction([txidOf(1)])
  await storage.validateResolvedActionInput({}, { output: { outputId: 1 } })
  expect(statements).toHaveLength(3)
  for (const sql of statements) expect(sql).not.toMatch(/lockingScript|SELECT \*/i)
})
