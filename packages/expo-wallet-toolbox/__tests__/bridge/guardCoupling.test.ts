/**
 * Spec 8, cross-namespace guard coupling, against the REAL guard and the REAL lookup SQL
 * (node:sqlite, the schema the device runs). `example.com`, `example.com.<tag1>.unverified.invalid`
 * and `example.com.<tag2>.unverified.invalid` cannot spend, relinquish or internalize each other's
 * unbasketed outputs, and cannot `sendWith` each other's held transactions. Outputs in ordinary
 * baskets are not coupled (the positive control). A change to the guard's own-label rule or to the
 * SQL that breaks this fails here.
 */
import { DatabaseSync } from 'node:sqlite'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { guardVaultAccess, VaultAccessDenied } from '../../core/services/vault/guard'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { originatorLabel } from '../../core/storage/methods/vaultGuardSql'

const ADMIN = 'admin.wallet'
const V = 'example.com'
const U1 = 'example.com.gaaaaaaaaaa.unverified.invalid'
const U2 = 'example.com.gbbbbbbbbbb.unverified.invalid'
const NOW = '2026-10-27T00:00:00.000Z'

let raw: DatabaseSync
let storage: StorageExpoSQLite
let refs = 0

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => void db.exec(sql),
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

async function one(db: ReturnType<typeof adapt>, sql: string, params: unknown[] = []): Promise<number> {
  const row = (await db.getFirstAsync(sql, params)) as { id: number }
  return row.id
}

/** A real transaction with `n` outputs, so internalizeAction's BEEF parses to a known txid. */
function makeTx(n: number, base: number) {
  const tx = new Transaction()
  for (let i = 0; i < n; i++) tx.addOutput({ satoshis: base + i, lockingScript: LockingScript.fromHex('51') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { txid: tx.id('hex'), atomic: beef.toBinaryAtomic(tx.id('hex')) }
}

/** Stores `tx` as created by `originator`'s action: output 0 unbasketed, output 1 in `stuff`. */
async function seed(db: ReturnType<typeof adapt>, tx: { txid: string }, originator: string, basketId: number) {
  await db.runAsync(
    `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
     VALUES (?, ?, 1, 'nosend', ?, 1, 0, ?)`,
    [NOW, NOW, `ref-${refs++}`, tx.txid]
  )
  const transactionId = await one(db, 'SELECT MAX(transactionId) AS id FROM transactions')
  const label = originatorLabel(originator)
  await db.runAsync(`INSERT OR IGNORE INTO tx_labels (created_at, updated_at, userId, label) VALUES (?, ?, 1, ?)`, [
    NOW,
    NOW,
    label
  ])
  const txLabelId = await one(db, 'SELECT txLabelId AS id FROM tx_labels WHERE label = ?', [label])
  await db.runAsync(
    `INSERT INTO tx_labels_map (created_at, updated_at, txLabelId, transactionId) VALUES (?, ?, ?, ?)`,
    [NOW, NOW, txLabelId, transactionId]
  )
  for (const [vout, basket] of [
    [0, null],
    [1, basketId]
  ] as const) {
    await db.runAsync(
      `INSERT INTO outputs (created_at, updated_at, userId, transactionId, basketId, spendable, change,
         vout, satoshis, providedBy, txid, lockingScript)
       VALUES (?, ?, 1, ?, ?, 1, 0, ?, 1000, 'you', ?, ?)`,
      [NOW, NOW, transactionId, basket, vout, tx.txid, new Uint8Array(25)]
    )
  }
}

const calls: string[] = []
function wallet() {
  const rec = (m: string) => async () => (calls.push(m), { ok: true })
  return {
    createAction: rec('createAction'),
    internalizeAction: rec('internalizeAction'),
    relinquishOutput: rec('relinquishOutput')
  } as never
}

let guarded: any
const mine = { u1: makeTx(2, 1000), u2: makeTx(2, 2000), v: makeTx(2, 3000) }

beforeEach(async () => {
  calls.length = 0
  raw = new DatabaseSync(':memory:')
  const db = adapt(raw)
  await createTables(db as never)
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  ;(storage as unknown as { db: unknown }).db = db
  await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
    NOW,
    NOW,
    '02' + 'a'.repeat(62)
  ])
  await db.runAsync(
    `INSERT INTO output_baskets (created_at, updated_at, userId, name, numberOfDesiredUTXOs, minimumDesiredUTXOValue)
     VALUES (?, ?, 1, 'stuff', 6, 1000)`,
    [NOW, NOW]
  )
  const basketId = await one(db, 'SELECT MAX(basketId) AS id FROM output_baskets')
  await seed(db, mine.u1, U1, basketId)
  await seed(db, mine.u2, U2, basketId)
  await seed(db, mine.v, V, basketId)
  guarded = guardVaultAccess(wallet(), ADMIN, { lookup: storage })
})
afterEach(() => raw.close())

const spend = (outpoint: string) => ({ description: 'spend it', inputs: [{ outpoint, inputDescription: 'in' }] })
const internalize = (t: { atomic: number[] }, basket: string, index: number) => ({
  tx: t.atomic,
  description: 'internalize',
  outputs: [{ outputIndex: index, protocol: 'basket insertion', insertionRemittance: { basket } }]
})

const PAIRS: Array<[string, string, string, keyof typeof mine, keyof typeof mine]> = [
  ['example.com', V, U1, 'v', 'u1'],
  ['namespace 1', U1, V, 'u1', 'v'],
  ['namespace 1 versus namespace 2', U1, U2, 'u1', 'u2'],
  ['namespace 2 versus namespace 1', U2, U1, 'u2', 'u1']
]

describe.each(PAIRS)('%s', (_name, caller, _other, ownKey, otherKey) => {
  const own = () => mine[ownKey]
  const other = () => mine[otherKey]

  it("createAction: the other namespace's unbasketed output is refused, its own is allowed", async () => {
    await expect(guarded.createAction(spend(`${other().txid}.0`), caller)).rejects.toBeInstanceOf(VaultAccessDenied)
    await expect(guarded.createAction(spend(`${own().txid}.0`), caller)).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['createAction'])
  })

  it('relinquishOutput: same rule', async () => {
    await expect(guarded.relinquishOutput({ basket: 'x', output: `${other().txid}.0` }, caller)).rejects.toBeInstanceOf(
      VaultAccessDenied
    )
    await expect(guarded.relinquishOutput({ basket: 'x', output: `${own().txid}.0` }, caller)).resolves.toEqual({
      ok: true
    })
  })

  it('internalizeAction: same rule', async () => {
    await expect(guarded.internalizeAction(internalize(other(), 'x', 0), caller)).rejects.toBeInstanceOf(
      VaultAccessDenied
    )
    await expect(guarded.internalizeAction(internalize(own(), 'x', 0), caller)).resolves.toEqual({ ok: true })
  })

  it("sendWith of the other namespace's held txid is refused, its own is allowed", async () => {
    await expect(
      guarded.createAction({ description: 'release', options: { sendWith: [other().txid] } }, caller)
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    await expect(
      guarded.createAction({ description: 'release', options: { sendWith: [own().txid] } }, caller)
    ).resolves.toEqual({ ok: true })
  })

  it("positive control: the other namespace's ordinary-basket output is allowed", async () => {
    await expect(guarded.createAction(spend(`${other().txid}.1`), caller)).resolves.toEqual({ ok: true })
    await expect(guarded.relinquishOutput({ basket: 'stuff', output: `${other().txid}.1` }, caller)).resolves.toEqual({
      ok: true
    })
    await expect(guarded.internalizeAction(internalize(other(), 'stuff', 1), caller)).resolves.toEqual({ ok: true })
  })
})
