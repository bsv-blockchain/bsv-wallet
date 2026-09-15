/**
 * `repairSettledTokenTransaction`, against REAL SQLite and the real provider.
 *
 * THE FIXTURE IS THE 2026-09-15 INCIDENT. A token transfer was admitted by the
 * issuer's overlay — which broadcasts on admission — and 0.7 s later the wallet
 * aborted the still-`noSend` action that built it. What that left behind, and
 * what is set up below:
 *
 *   proven_tx_reqs.status  nosend → abortAction → 'invalid'
 *   transactions.status                          'failed'
 *   token_settlements.state                      'admitted'
 *   the input coin (f6d80d2e….2)                 spendable = 1  ← spent on chain
 *   the transfer's own change output             spendable = 0
 *
 * The spendable input is the money bug: the next send picked it up and the
 * overlay refused the child with `ERR_INPUT_SPENT`.
 *
 * No sanctioned toolbox API can undo this. `updateTransactionStatus` refuses
 * outright ("A 'failed' transaction may not be un-failed by this method"),
 * `reviewStatus` only moves rows towards failed, and `TaskUnFail` — the real
 * recovery path — demands a merkle path first, which a transaction broadcast
 * seconds ago cannot have. So the repair is written out through the provider's
 * own CRUD methods, and this suite is what says it does the same four things
 * `unfailTransactionsForProof` does, minus the `isUtxo` probe that would leave
 * a fresh broadcast's change permanently unspendable.
 */
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) {
      this.db.exec(sql)
    }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...params)
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).get(...params) ?? null
    }
    async getAllAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).all(...params)
    }
    async withExclusiveTransactionAsync(fn: (transaction: TestDatabase) => Promise<void>) {
      this.db.exec('BEGIN')
      try {
        await fn(this)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    async closeAsync() {
      this.db.close()
    }
  }
  return { openDatabaseAsync: async () => new TestDatabase() }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

import { LockingScript, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'

const IDENTITY = new PrivateKey(42).toPublicKey().toString()
/** The coin the abort wrongly released: f6d80d2e….2, spent on chain. */
const INPUT_TXID = 'f6d80d2e' + '11'.repeat(28)
const INPUT_VOUT = 2
const OVERLAY_KEY = '02' + 'cd'.repeat(32)
const NOW = new Date('2026-09-15T12:00:00Z')

/** The transfer, spending `INPUT_TXID.INPUT_VOUT` into one output. */
function transferTx(): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: INPUT_TXID,
    sourceOutputIndex: INPUT_VOUT,
    unlockingScript: UnlockingScript.fromHex(''),
    sequence: 0xffffffff
  })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
  return tx
}

const TX = transferTx()
const TXID = TX.id('hex')
const RAW = TX.toBinary()

let storage: StorageExpoSQLite
let userId: number
/** The transfer's own transaction row. */
let transactionId: number
/** The row holding the released input coin. */
let inputOutputId: number
/** The transfer's own (change-shaped) output row. */
let ownOutputId: number

/**
 * Lay the incident's state down.
 *
 * `inputSpendable` / `txStatus` / `reqStatus` are parameters because the point
 * of several tests below is that the repair only fires on the damaged shape.
 */
async function seed(
  over: { txStatus?: string; reqStatus?: string; withReq?: boolean; ownSpentBy?: number } = {}
): Promise<void> {
  userId = await storage.insertUser({
    created_at: NOW,
    updated_at: NOW,
    userId: 0,
    identityKey: IDENTITY
  } as never)

  // The transaction that produced the input coin.
  const parentId = await storage.insertTransaction({
    created_at: NOW,
    updated_at: NOW,
    transactionId: 0,
    userId,
    status: 'completed',
    reference: 'parent-action',
    isOutgoing: false,
    satoshis: 1000,
    description: 'the coin this transfer spends',
    txid: INPUT_TXID
  } as never)

  // …restored to spendable by `updateTransactionStatus('failed')`. It is spent
  // on chain; this row is the lie the repair exists to correct.
  inputOutputId = await storage.insertOutput({
    created_at: NOW,
    updated_at: NOW,
    outputId: 0,
    userId,
    transactionId: parentId,
    spendable: true,
    change: true,
    vout: INPUT_VOUT,
    satoshis: 1000,
    providedBy: 'storage',
    txid: INPUT_TXID
  } as never)

  transactionId = await storage.insertTransaction({
    created_at: NOW,
    updated_at: NOW,
    transactionId: 0,
    userId,
    status: over.txStatus ?? 'failed',
    reference: 'the-noSend-action',
    isOutgoing: true,
    satoshis: -1000,
    description: 'the aborted token transfer',
    txid: TXID,
    rawTx: RAW
  } as never)

  // Made unspendable by `markFailedTransactionOutputsNotSpendable`.
  ownOutputId = await storage.insertOutput({
    created_at: NOW,
    updated_at: NOW,
    outputId: 0,
    userId,
    transactionId,
    spendable: false,
    change: true,
    vout: 0,
    satoshis: 1,
    providedBy: 'storage',
    txid: TXID,
    ...(over.ownSpentBy != null ? { spentBy: over.ownSpentBy } : {})
  } as never)

  if (over.withReq !== false) {
    await storage.insertProvenTxReq({
      created_at: NOW,
      updated_at: NOW,
      provenTxReqId: 0,
      txid: TXID,
      status: over.reqStatus ?? 'invalid',
      attempts: 4,
      notified: false,
      history: '{}',
      notify: JSON.stringify({ transactionIds: [transactionId] }),
      rawTx: RAW
    } as never)
  }

  // And the settlement row that disagrees with all of it.
  await createSettlementStore(storage.sqliteDb as unknown as SettlementDb).upsertSettlement({
    txid: TXID,
    role: 'sent',
    assetId: `${'ee'.repeat(32)}.0`,
    state: 'admitted',
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: OVERLAY_KEY,
    reference: 'the-noSend-action'
  })
}

const outputById = async (outputId: number) => (await storage.findOutputs({ partial: { outputId } } as never))[0]
const txRow = async () => (await storage.findTransactions({ partial: { transactionId }, noRawTx: true } as never))[0]
const reqRow = async () => (await storage.findProvenTxReqs({ partial: { txid: TXID } } as never))[0]

beforeEach(async () => {
  storage = new StorageExpoSQLite({ chain: 'main', identityKey: IDENTITY, databaseName: 'repair-test' } as never)
  await storage.migrate('test', IDENTITY)
})

afterEach(async () => {
  await storage.destroy()
})

describe('repairSettledTokenTransaction', () => {
  it('restores the whole of the wallet’s view of a transaction it wrongly failed', async () => {
    await seed()

    const result = await storage.repairSettledTokenTransaction(TXID)

    expect(result).toMatchObject({
      txid: TXID,
      transactionIds: [transactionId],
      wasTxStatuses: ['failed'],
      wasReqStatus: 'invalid',
      inputsMarkedSpent: 1,
      outputsMadeSpendable: 1,
      reqCreated: false
    })

    // 1. the transaction is live again — broadcast, awaiting proof.
    expect((await txRow()).status).toBe('unproven')

    // 2. THE MONEY FIX: the coin this transaction spends is spent again.
    const input = await outputById(inputOutputId)
    expect(input.spendable).toBe(false)
    expect(input.spentBy).toBe(transactionId)

    // 3. its own output is usable again.
    expect((await outputById(ownOutputId)).spendable).toBe(true)

    // 4. the request is back in a status `TaskCheckForProofs` polls, with its
    //    attempt count reset so the proof lookup is not already exhausted.
    const req = await reqRow()
    expect(req.status).toBe('unmined')
    expect(req.attempts).toBe(0)
  })

  it('is idempotent — a second pass finds nothing damaged and writes nothing', async () => {
    await seed()
    expect(await storage.repairSettledTokenTransaction(TXID)).toBeTruthy()

    expect(await storage.repairSettledTokenTransaction(TXID)).toBeUndefined()
    expect((await txRow()).status).toBe('unproven')
    expect((await outputById(inputOutputId)).spentBy).toBe(transactionId)
  })

  it('repairs a transaction whose REQUEST alone went invalid', async () => {
    await seed({ txStatus: 'unproven', reqStatus: 'invalid' })

    const result = await storage.repairSettledTokenTransaction(TXID)

    expect(result?.wasReqStatus).toBe('invalid')
    expect((await reqRow()).status).toBe('unmined')
    // The inputs are re-marked regardless of which record was damaged: the
    // question the repair answers is "does the wallet's state match a
    // transaction that is on chain", not "which row noticed first".
    expect((await outputById(inputOutputId)).spentBy).toBe(transactionId)
  })

  it('leaves a healthy transaction entirely alone', async () => {
    await seed({ txStatus: 'unproven', reqStatus: 'unmined' })

    expect(await storage.repairSettledTokenTransaction(TXID)).toBeUndefined()
    expect((await outputById(inputOutputId)).spendable).toBe(true)
    expect((await outputById(ownOutputId)).spendable).toBe(false)
  })

  it('never un-spends its own output when something else has since spent it', async () => {
    // A newer fact about that coin. Undoing it would be the same class of bug
    // in the other direction.
    await seed({ ownSpentBy: 999 })

    const result = await storage.repairSettledTokenTransaction(TXID)

    expect(result?.outputsMadeSpendable).toBe(0)
    const own = await outputById(ownOutputId)
    expect(own.spendable).toBe(false)
    expect(own.spentBy).toBe(999)
  })

  it('rebuilds a request that has gone entirely, from the transaction’s own bytes', async () => {
    await seed({ withReq: false })

    const result = await storage.repairSettledTokenTransaction(TXID)

    expect(result).toMatchObject({ reqCreated: true, wasReqStatus: undefined })
    const req = await reqRow()
    expect(req.status).toBe('unmined')
    expect(req.txid).toBe(TXID)
    // Without a notify list the monitor would prove the transaction and tell
    // nobody, leaving the row at 'unproven' for good.
    expect(JSON.parse(req.notify as unknown as string)).toEqual({ transactionIds: [transactionId] })
  })

  it('does nothing for a txid this wallet has no transaction for', async () => {
    await seed()
    expect(await storage.repairSettledTokenTransaction('ff'.repeat(32))).toBeUndefined()
  })

  it('refuses to guess when there are no raw bytes to read the inputs from', async () => {
    await seed({ withReq: false })
    // A transaction row whose rawTx has been purged: the inputs are unknowable,
    // and marking nothing is better than marking the wrong coins.
    await storage.sqliteDb!.runAsync('UPDATE transactions SET rawTx = NULL WHERE transactionId = ?', [transactionId])

    expect(await storage.repairSettledTokenTransaction(TXID)).toBeUndefined()
    expect((await txRow()).status).toBe('failed')
    expect((await outputById(inputOutputId)).spendable).toBe(true)
  })
})
