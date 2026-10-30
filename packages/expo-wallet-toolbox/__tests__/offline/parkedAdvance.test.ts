/**
 * FIX F, part 1, against REAL SQLite and the drain's own query.
 *
 * `__tests__/offline/payerHold.test.ts` mocks the SQL mapper and pins which
 * calls are made. This pins the thing that actually broke: with a `parked` row
 * already present, `insertOfflineAction`'s `INSERT OR IGNORE` on a UNIQUE txid
 * left the row `parked` forever — neither drainable (`processOfflineActions`
 * reads only 'queued'/'posting') nor cancellable (`cancelParkedPayment`
 * refuses anything past 'nosend', and the promotion had just moved it past).
 *
 * So the assertion is not "an UPDATE was issued" but "the drain's own selection
 * now returns this row".
 */
import { DatabaseSync } from 'node:sqlite'
import type { WalletInterface } from '@bsv/sdk'
import { createTables } from '../../core/storage/schema/createTables'
import { findOfflineActions, type OfflineActionRow } from '../../core/storage/methods/offlineActions'
import { holdSentPaymentOffline, parkSentPaymentOffline, releaseParkedPayment } from '../../core/offline/payerHold'
import { createNearbyPayer } from '../../core/mandala/nearby'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import { TaskSendOffline } from '../../core/monitor/TaskSendOffline'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

const TXID = 'aa'.repeat(32)
const ASSET = 'ab'.repeat(32) + '_0'

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

let raw: DatabaseSync
let conn: ReturnType<typeof adapt>
let promoted: [string, number][]

function storageStub(txStatus: string) {
  return {
    sqliteDb: conn,
    findTransactions: async () => [{ transactionId: 99, userId: 7, status: txStatus }],
    updateTransactionStatus: async (status: string, transactionId: number) => {
      promoted.push([status, transactionId])
    }
  } as unknown as StorageExpoSQLite
}

/** Exactly what `processOfflineActions` selects. */
const drainable = () => findOfflineActions(conn as never, { status: ['queued', 'posting'] })

let log: jest.SpyInstance

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  conn = adapt(raw)
  await createTables(conn as never)
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (7,'n','n','k')`).run()
  promoted = []
  TaskSendOffline.resetForTests()
  log = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  raw.close()
})

it('park → hold leaves exactly one row, queued and drainable', async () => {
  await parkSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID, framePayload: 'bsvpayf1:abc' })

  expect(await drainable()).toEqual([])
  expect(promoted).toEqual([])

  await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID })

  const rows = await drainable()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ txid: TXID, status: 'queued', role: 'sent' })
  // The frame the payer parked with survives, so the code is still re-showable.
  expect(rows[0].framePayload).toBe('bsvpayf1:abc')
  expect(promoted).toEqual([['unproven', 99]])
  expect(TaskSendOffline.hasPending).toBe(true)
  expect((raw.prepare('SELECT COUNT(*) AS n FROM offline_actions').get() as { n: number }).n).toBe(1)
})

it('hold with no prior row still inserts one, queued', async () => {
  await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID, framePayload: 'bsvpayf1:xyz' })

  expect(await drainable()).toEqual([
    expect.objectContaining({ txid: TXID, status: 'queued', framePayload: 'bsvpayf1:xyz' })
  ])
})

it('a repeated confirm never duplicates the row or re-promotes a moved transaction', async () => {
  await parkSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID })
  await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID })
  await holdSentPaymentOffline({ storage: storageStub('unproven'), txid: TXID })

  expect(await drainable()).toHaveLength(1)
  expect(promoted).toEqual([['unproven', 99]])
})

// ─────────────────── the payer's own durability (plan 07 Task 15) ───────────────────
//
// A token payment's durable host record is its `color_transfers` row (W1).
// The runtime journals it `built` at hand-over time, before any frame exists,
// so nothing here depends on the session key that seals `framePayload`: park
// and hold only move that row forward through `nearby.onHandedOver`.

let journal: TransferJournal

/** The runtime's real hook over this test's database. */
const hooks = () =>
  createNearbyPayer({
    wallet: { abortAction: async () => ({ aborted: true }) } as unknown as WalletInterface,
    identityKey: async () => '02'.padEnd(66, 'a'),
    journal,
    hostWallet: {} as WalletInterface,
    ledger: { get: async () => undefined, put: async r => r, list: async () => [] },
    bodies: { put: async () => {}, get: async () => undefined },
    recipientRefusal: () => null
  })

async function journalBuilt(): Promise<void> {
  await journal.insert({
    txid: TXID,
    role: 'sent',
    state: 'built',
    assetId: ASSET,
    units: 250n,
    outputIndex: 0,
    rail: 'nearby',
    delivered: false,
    reference: 'ref-1'
  })
}

describe('a token payment’s journal row moves with its queue row', () => {
  beforeEach(async () => {
    journal = createTransferJournal(conn as unknown as JournalDb)
    await journalBuilt()
  })

  it('park moves the row to parked and leaves nothing drainable', async () => {
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      onHandedOver: hooks().onHandedOver
    })

    expect(await journal.get(TXID)).toMatchObject({ state: 'parked', role: 'sent', assetId: ASSET })
    // `parked` is the USER's state: nobody settles it (FIX F), and the queue
    // row is not drainable either.
    expect(await drainable()).toEqual([])
  })

  it('park → confirm advances BOTH rows in the same confirm', async () => {
    const { onHandedOver } = hooks()
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      onHandedOver
    })

    await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID, onHandedOver })

    expect(await drainable()).toEqual([expect.objectContaining({ txid: TXID, status: 'queued' })])
    expect(await journal.get(TXID)).toMatchObject({ state: 'handed_over', delivered: true })
  })

  it('releaseParkedPayment advances the journal row too', async () => {
    const { onHandedOver } = hooks()
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      onHandedOver
    })

    await releaseParkedPayment({ storage: storageStub('nosend'), txid: TXID, isTokenHold: true, onHandedOver })

    expect(await drainable()).toEqual([expect.objectContaining({ txid: TXID, status: 'queued' })])
    expect((await journal.get(TXID))?.state).toBe('handed_over')
  })

  it('leaves a BSV hand-over’s journal alone', async () => {
    await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID })
    expect((await journal.get(TXID))?.state).toBe('built')
  })

  // XR-036, re-keyed: a hold whose journal hook fails leaves the queue row
  // parked rather than queued. The broadcast hold would still hold the tx (a
  // row short of `settled` holds, W1), but a queued row whose journal never
  // reads `handed_over` is a payment nothing will ever settle.
  it('a throwing hook leaves the queue row parked, not drainable, for a token hold', async () => {
    await expect(
      holdSentPaymentOffline({
        storage: storageStub('nosend'),
        txid: TXID,
        onHandedOver: async () => {
          throw new Error('db locked')
        }
      })
    ).resolves.toBeUndefined()

    expect(await drainable()).toEqual([])
    const rows = (await findOfflineActions(conn as never, {})) as OfflineActionRow[]
    expect(rows).toEqual([expect.objectContaining({ txid: TXID, status: 'parked' })])
    expect(promoted).toEqual([['unproven', 99]])
  })
})
