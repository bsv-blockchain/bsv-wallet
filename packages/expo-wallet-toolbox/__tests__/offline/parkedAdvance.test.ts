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
import { Beef, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { createTables } from '../../core/storage/schema/createTables'
import { findOfflineActions, type OfflineActionRow } from '../../core/storage/methods/offlineActions'
import {
  holdSentPaymentOffline,
  parkSentPaymentOffline,
  releaseParkedPayment
} from '../../core/offline/payerHold'
import { createSettlementStore, type SettlementDb, type SqlSettlementStore } from '../../core/mandala/settlementStore'
import {
  forgetSessionPsks,
  sealedFramePayloadDecoder,
  tokenFrameSourcesFromOfflineActions
} from '../../core/offline/tokenFrames'
import { TaskSendOffline } from '../../core/monitor/TaskSendOffline'
import type { EvidenceFrame, TokenHandedOverHook } from '../../core/mandala/types'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

const TXID = 'aa'.repeat(32)
const ASSET = 'ab'.repeat(32) + '.0'
const OVERLAY = 'https://overlay.issuer.example'
const OVERLAY_KEY = '03'.padEnd(66, 'b')

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
  forgetSessionPsks()
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


// ─────────────────── the payer's own durability (spec §4.4, §5) ───────────────────
//
// `offline_actions.framePayload` is the frame SEALED with the nearby session's
// PSK, and that key lives in memory only — so a payer that restarts can no
// longer open its own frame, and a `token_settlements` row derived ONLY from it
// simply never exists. With no row, `processOfflineActions` reads the payment as
// an ordinary BSV transaction and broadcasts an unadmitted token tip.
//
// So park/hold are handed the PLAINTEXT frame while it is still open.

function tokenFrame(): EvidenceFrame {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, 250, new Array(20).fill(9)) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return {
    kind: 'token',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    token: { assetId: ASSET, overlayUrl: OVERLAY, overlayIdentityKey: OVERLAY_KEY, linkage: [], admissions: [] },
    transaction: new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
  }
}

let settlements: SqlSettlementStore

/** What the Mandala runtime implements: upsert the row at the state it was told. */
const onTokenHandedOver: TokenHandedOverHook = async (frame, txid, state) => {
  const existing = await settlements.getSettlement(txid)
  await settlements.upsertSettlement({
    txid,
    role: 'sent',
    assetId: frame.token!.assetId,
    state: existing?.state ?? state,
    counterpartyKey: frame.senderIdentityKey,
    overlayUrl: frame.token!.overlayUrl,
    overlayIdentityKey: frame.token!.overlayIdentityKey,
    createdAt: existing?.createdAt
  })
}

describe('a token payment’s settlement row survives the session key', () => {
  beforeEach(() => {
    settlements = createSettlementStore(conn as unknown as SettlementDb)
  })

  it('park writes the row from the plaintext frame, at parked', async () => {
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      frame: tokenFrame(),
      onTokenHandedOver
    })

    expect(await settlements.getSettlement(TXID)).toMatchObject({ state: 'parked', role: 'sent', assetId: ASSET })
    // `parked` is the USER's state: the drain must never pull it into a submit
    // set, and it does not make the payment drainable either.
    expect(await drainable()).toEqual([])
  })

  it('park → confirm advances BOTH rows in the same confirm', async () => {
    const frame = tokenFrame()
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      frame,
      onTokenHandedOver
    })

    await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID, frame, onTokenHandedOver })

    expect(await drainable()).toEqual([expect.objectContaining({ txid: TXID, status: 'queued' })])
    // The settlement twin of that advance. `upsertSettlement` never writes
    // `state` on conflict, so without the explicit advance the row would sit at
    // `parked` forever — the one non-terminal state the drain refuses to
    // submit — and the payer's optional submit (rule 6) could never start.
    expect((await settlements.getSettlement(TXID))?.state).toBe('handed_over')
  })

  it('releaseParkedPayment advances the settlement row too, with no frame in hand', async () => {
    await parkSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      frame: tokenFrame(),
      onTokenHandedOver
    })

    await releaseParkedPayment({ storage: storageStub('nosend'), txid: TXID })

    expect(await drainable()).toEqual([expect.objectContaining({ txid: TXID, status: 'queued' })])
    expect((await settlements.getSettlement(TXID))?.state).toBe('handed_over')
  })

  // The whole reason the plaintext frame is threaded through: after a restart
  // the PSK is gone, so the sealed `framePayload` yields NOTHING — and the row
  // has to already be there.
  it('after a restart with no PSK the row still gates the tip', async () => {
    await holdSentPaymentOffline({
      storage: storageStub('nosend'),
      txid: TXID,
      framePayload: 'bsvpayf1:sealed',
      frame: tokenFrame(),
      onTokenHandedOver
    })

    // Restart: the process forgets every session key it held.
    forgetSessionPsks()
    const rows = (await findOfflineActions(conn as never, {})) as OfflineActionRow[]
    expect(tokenFrameSourcesFromOfflineActions(rows, sealedFramePayloadDecoder())).toEqual([])

    // …and the settlement row is still there, so `processOfflineActions` takes
    // its token branch and `attemptToPostReqsToNetwork`'s guard #2 — which is
    // literally this query — still holds the request.
    const fresh = createSettlementStore(conn as unknown as SettlementDb)
    expect((await fresh.getSettlement(TXID))?.state).toBe('handed_over')
    expect([...(await fresh.settlementTxidsIn([TXID]))]).toEqual([TXID])
  })

  it('leaves a BSV hand-over with no settlement row at all', async () => {
    await holdSentPaymentOffline({ storage: storageStub('nosend'), txid: TXID, onTokenHandedOver })
    expect(await settlements.getSettlement(TXID)).toBeUndefined()
  })

  // The queue row is the durable fact; a settlement write is a re-derivable
  // cache (FIX G). A failing cache write must not un-queue a real payment.
  it('a throwing hook never costs the payment its queue row', async () => {
    await expect(
      holdSentPaymentOffline({
        storage: storageStub('nosend'),
        txid: TXID,
        frame: tokenFrame(),
        onTokenHandedOver: async () => {
          throw new Error('db locked')
        }
      })
    ).resolves.toBeUndefined()

    expect(await drainable()).toEqual([expect.objectContaining({ txid: TXID, status: 'queued' })])
    expect(promoted).toEqual([['unproven', 99]])
  })
})
