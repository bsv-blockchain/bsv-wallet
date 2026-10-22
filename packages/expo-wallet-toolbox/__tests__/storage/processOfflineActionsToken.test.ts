/**
 * The one branch `processOfflineActions` keeps for 1Color settlement.
 *
 * The drain no longer settles anything itself: the color module's `settle`
 * submits to the Mandala overlay (which broadcasts what it admits), and the
 * runtime records the verdict in `color_transfers`. What is pinned here is the
 * SEAM: a step whose tx carries a 1Color output and whose journal row is not
 * `settled` is a `serviceError` — never posted, its queue row left `queued` —
 * and once the row reads `settled` the very next pass posts it through the
 * ordinary `postOwned`. A plain BSV step never touches the journal. A journal
 * read fault stalls the step and never posts (XR-045).
 *
 * A foreign 1Color ancestor (a counterparty's own unsettled change, inside the
 * receipt's BEEF) has no journal row of its own and never will. It is released
 * once a descendant in the same graph reads `settled`: that descendant's
 * admission means the overlay already took, and broadcast, the chain it
 * spends, so re-posting the ancestor cannot put an unadmitted token tx on the
 * network. Until then it holds, and blocks its subtree.
 */
jest.mock('../../core/net/online', () => ({ getOnline: jest.fn(async () => true) }))

const mockPostReqs = jest.fn()
jest.mock('@bsv/wallet-toolbox-mobile', () => ({
  ...jest.requireActual('@bsv/wallet-toolbox-mobile'),
  attemptToPostReqsToNetwork: (...args: unknown[]) => mockPostReqs(...args)
}))

import type { DatabaseSync } from 'node:sqlite'
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import type { TableProvenTxReq } from '@bsv/wallet-toolbox-mobile'
import { postOwnedByTxid, processOfflineActions } from '../../core/storage/methods/processOfflineActions'
import { getOnline } from '../../core/net/online'
import type { BindValue, OfflineActionRow } from '../../core/storage/methods/offlineActions'
import { colorHeldTxids } from '../../core/mandala/colorGuard'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import type { ColorTransferState } from '../../core/mandala/types'
import { openTestDb } from '../__helpers__/nodeSqlite'

const ASSET_ID = 'ab'.repeat(32) + '_0'
const PKH = PrivateKey.fromRandom().toPublicKey().toHash() as number[]

function txSpending(sourceTXID: string, lockingScript: LockingScript = LockingScript.fromHex('51')): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript })
  return tx
}
const tokenTxSpending = (sourceTXID: string, amount = 1500n) =>
  txSpending(sourceTXID, new OneColor().lock(ASSET_ID, amount, PKH))

const row = (over: Partial<OfflineActionRow>): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  userId: 1,
  txid: 'a'.repeat(64),
  seq: 1,
  role: 'received',
  senderIdentityKey: null,
  receivedVia: null,
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  framePayload: null,
  ...over
})

const req = (over: Partial<TableProvenTxReq>): TableProvenTxReq =>
  ({
    provenTxReqId: 1,
    created_at: new Date(),
    updated_at: new Date(),
    txid: 'a'.repeat(64),
    status: 'nosend',
    attempts: 0,
    notified: false,
    history: '{}',
    notify: '{"transactionIds":[11]}',
    rawTx: [],
    ...over
  }) as unknown as TableProvenTxReq

function fakeDb(rows: OfflineActionRow[]) {
  const writes: { sql: string; params: BindValue[] }[] = []
  return {
    writes,
    getAllAsync: async (sql: string, params: BindValue[]) =>
      sql.includes('status IN') ? rows.filter(r => params.includes(r.status)) : rows,
    runAsync: async (sql: string, params: BindValue[]) => {
      writes.push({ sql, params })
    },
    getFirstAsync: async () => undefined
  }
}

/** The last status this pass wrote for `txid`'s queue row. */
const QUEUE_STATUSES: BindValue[] = ['queued', 'posting', 'sent', 'rejected']
const lastStatusOf = (db: ReturnType<typeof fakeDb>, txid: string) =>
  db.writes
    .filter(w => w.sql.includes('offline_actions') && w.params.includes(txid))
    .at(-1)
    ?.params.find(p => QUEUE_STATUSES.includes(p))

const FAKE_PROOF_HEIGHT = 700_000

let raw: DatabaseSync
let journal: TransferJournal
let log: jest.SpyInstance

function fakeStorage(args: {
  db: ReturnType<typeof fakeDb>
  reqs: TableProvenTxReq[]
  postBeef?: jest.Mock
  networkHas?: Record<string, 'mined' | 'known'>
  proven?: string[]
  /** The journal `colorHeldTxids` reads; defaults to the real one over node:sqlite. */
  statesOf?: TransferJournal['statesOf']
}) {
  const colorHeld = jest.fn(async (reqs: readonly { txid: string; rawTx?: readonly number[] }[]) =>
    colorHeldTxids(reqs, { statesOf: args.statesOf ?? (txids => journal.statesOf(txids)) })
  )
  return {
    sqliteDb: args.db,
    colorHeldTxids: colorHeld,
    findProvenTxReqs: async (a: { partial: { txid?: string } }) =>
      args.reqs.filter(r => a.partial.txid === undefined || r.txid === a.partial.txid).map(r => ({ ...r })),
    findTransactions: async () => [{ transactionId: 11, status: 'unproven' }],
    updateProvenTxReq: jest.fn(),
    updateTransactionStatus: jest.fn(),
    getServices: () => ({
      postBeef: args.postBeef ?? jest.fn(async () => []),
      getStatusForTxids: async (txids: string[]) => ({
        name: 'fake',
        status: 'success',
        results: txids.map(t => ({ txid: t, depth: undefined, status: args.networkHas?.[t] ?? 'unknown' }))
      }),
      getChainTracker: async () => ({
        isValidRootForHeight: async (root: string, height: number) =>
          height === FAKE_PROOF_HEIGHT && (args.proven ?? []).includes(root)
      }),
      getMerklePath: async (txid: string) =>
        (args.proven ?? []).includes(txid)
          ? {
              merklePath: { blockHeight: FAKE_PROOF_HEIGHT, path: [[{ offset: 0, hash: txid, txid: true }]] },
              header: {
                version: 1,
                previousHash: 'bb'.repeat(32),
                merkleRoot: txid,
                time: 1_700_000_000,
                bits: 486604799,
                nonce: 12345,
                height: FAKE_PROOF_HEIGHT,
                hash: 'cc'.repeat(32)
              }
            }
          : {}
    })
  }
}

async function journalRow(txid: string, state: ColorTransferState, role: 'sent' | 'received' = 'received') {
  await journal.insert({
    txid,
    role,
    assetId: ASSET_ID,
    units: 1500n,
    outputIndex: 0,
    rail: 'nearby',
    state,
    delivered: false
  })
}

beforeEach(async () => {
  mockPostReqs.mockReset()
  ;(getOnline as jest.Mock).mockReset().mockResolvedValue(true)
  let db
  ;({ raw, db } = await openTestDb())
  journal = createTransferJournal(db as JournalDb)
  log = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  raw.close()
})

describe('processOfflineActions color branch', () => {
  it('holds an unsettled 1Color step as serviceError and leaves its row queued', async () => {
    const tx = tokenTxSpending('11'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'held')

    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [req({ txid, rawTx: tx.toBinary() })] })
    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, rejected: 0, stopped: true })
    expect(lastStatusOf(db, txid)).toBe('queued')
    expect((await journal.get(txid))!.state).toBe('held')
  })

  it('holds a 1Color step that has no journal row at all', async () => {
    const tx = tokenTxSpending('12'.repeat(32))
    const txid = tx.id('hex')
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [req({ txid, rawTx: tx.toBinary() })] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r.sent).toBe(0)
    expect(lastStatusOf(db, txid)).toBe('queued')
  })

  it('posts it on the next pass once the journal row is settled, and marks it sent', async () => {
    const tx = tokenTxSpending('13'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'held')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api] })

    await processOfflineActions({ storage: storage as never })
    expect(mockPostReqs).not.toHaveBeenCalled()

    expect(await journal.advance(txid, ['held'], 'settled')).toBe(true)
    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(1)
    expect(lastStatusOf(db, txid)).toBe('sent')
  })

  it('stalls the step on a journal read fault and never posts', async () => {
    const tx = tokenTxSpending('14'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'settled')
    const postBeef = jest.fn(async () => [])
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({
      db,
      reqs: [req({ txid, rawTx: tx.toBinary() })],
      postBeef,
      statesOf: async () => {
        throw new Error('database is locked')
      }
    })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(postBeef).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, rejected: 0 })
    expect(db.writes.some(w => w.params.includes('rejected'))).toBe(false)
    expect(lastStatusOf(db, txid)).toBe('queued')
  })

  it('leaves a plain BSV step entirely alone and never reads the journal for it', async () => {
    const tx = txSpending('22'.repeat(32), new P2PKH().lock(PKH))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const storage = fakeStorage({ db: fakeDb([row({ txid })]), reqs: [api] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r.sent).toBe(1)
    expect(storage.colorHeldTxids).not.toHaveBeenCalled()
  })

  it('holds the unsettled 1Color step and still releases an independent plain BSV root', async () => {
    const token = tokenTxSpending('15'.repeat(32))
    const plain = txSpending('16'.repeat(32))
    const tokenApi = req({ provenTxReqId: 1, txid: token.id('hex'), rawTx: token.toBinary() })
    const plainApi = req({ provenTxReqId: 2, txid: plain.id('hex'), rawTx: plain.toBinary() })
    mockPostReqs.mockImplementation(async (_s: unknown, reqs: { txid: string }[]) => {
      plainApi.status = 'unmined'
      return { details: reqs.map(r => ({ txid: r.txid, status: 'success' })) }
    })
    const db = fakeDb([row({ txid: token.id('hex') }), row({ offlineActionId: 2, txid: plain.id('hex'), seq: 2 })])
    const storage = fakeStorage({ db, reqs: [tokenApi, plainApi] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect((mockPostReqs.mock.calls[0][1] as { txid: string }[]).map(x => x.txid)).toEqual([plain.id('hex')])
    expect(r).toMatchObject({ sent: 1, stopped: true })
  })
})

// The single-txid door a runtime uses outside the queue loop. It calls the
// toolbox's module-level post directly, past the storage override, so it must
// carry the same hold itself or it is a way around the guard.
describe('postOwnedByTxid', () => {
  it('refuses an unsettled 1Color tx as serviceError, and posts it once settled', async () => {
    const tx = tokenTxSpending('17'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'handed_over', 'sent')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const storage = fakeStorage({ db: fakeDb([]), reqs: [api] })

    await expect(postOwnedByTxid(storage as never, txid)).resolves.toBe('serviceError')
    expect(mockPostReqs).not.toHaveBeenCalled()

    await journal.advance(txid, ['handed_over'], 'settled')
    await expect(postOwnedByTxid(storage as never, txid)).resolves.toBe('success')
    expect(mockPostReqs).toHaveBeenCalledTimes(1)
  })

  it('refuses on a journal read fault', async () => {
    const tx = tokenTxSpending('18'.repeat(32))
    const txid = tx.id('hex')
    const storage = fakeStorage({
      db: fakeDb([]),
      reqs: [req({ txid, rawTx: tx.toBinary() })],
      statesOf: async () => {
        throw new Error('database is locked')
      }
    })

    await expect(postOwnedByTxid(storage as never, txid)).resolves.toBe('serviceError')
    expect(mockPostReqs).not.toHaveBeenCalled()
  })
})

describe('a foreign 1Color ancestor inside a receipt BEEF', () => {
  function chain() {
    const parent = tokenTxSpending('31'.repeat(32), 2000n)
    const parentTxid = parent.id('hex')
    const child = tokenTxSpending(parentTxid)
    const childTxid = child.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeRawTx(parent.toBinary())
    const api = req({ txid: childTxid, rawTx: child.toBinary(), inputBEEF: inputBEEF.toBinary() })
    return { parentTxid, childTxid, api }
  }

  it('is held, with the owned child behind it, while the child is unsettled', async () => {
    const { childTxid, api } = chain()
    await journalRow(childTxid, 'held')
    const postBeef = jest.fn(async () => [])
    const db = fakeDb([row({ txid: childTxid })])
    const storage = fakeStorage({ db, reqs: [api], postBeef })

    const r = await processOfflineActions({ storage: storage as never })

    expect(postBeef).not.toHaveBeenCalled()
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, rejected: 0, stopped: true })
    expect(lastStatusOf(db, childTxid)).toBe('queued')
  })

  it('is released once the owned child reads settled, and the child posts after it', async () => {
    const { parentTxid, childTxid, api } = chain()
    await journalRow(childTxid, 'settled')
    const order: string[] = []
    const postBeef = jest.fn(async () => {
      order.push('foreign')
      return [{ txidResults: [{ txid: parentTxid, status: 'success' }] }]
    })
    mockPostReqs.mockImplementation(async () => {
      order.push('owned')
      api.status = 'unmined'
      return { details: [{ txid: childTxid, status: 'success' }] }
    })
    const db = fakeDb([row({ txid: childTxid })])
    const storage = fakeStorage({ db, reqs: [api], postBeef })

    const r = await processOfflineActions({ storage: storage as never })

    expect(order).toEqual(['foreign', 'owned'])
    expect(r).toMatchObject({ sent: 1, rejected: 0, stopped: false })
  })

  it('is held when its only descendant is plain BSV, which no settlement can vouch for', async () => {
    const parent = tokenTxSpending('41'.repeat(32), 2000n)
    const child = txSpending(parent.id('hex'))
    const inputBEEF = new Beef()
    inputBEEF.mergeRawTx(parent.toBinary())
    const api = req({ txid: child.id('hex'), rawTx: child.toBinary(), inputBEEF: inputBEEF.toBinary() })
    const postBeef = jest.fn(async () => [])
    const storage = fakeStorage({ db: fakeDb([row({ txid: child.id('hex') })]), reqs: [api], postBeef })

    const r = await processOfflineActions({ storage: storage as never })

    expect(postBeef).not.toHaveBeenCalled()
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r.stopped).toBe(true)
  })

  it('stalls on a journal read fault, never posting either', async () => {
    const { childTxid, api } = chain()
    await journalRow(childTxid, 'settled')
    const postBeef = jest.fn(async () => [])
    const storage = fakeStorage({
      db: fakeDb([row({ txid: childTxid })]),
      reqs: [api],
      postBeef,
      statesOf: async () => {
        throw new Error('database is locked')
      }
    })

    const r = await processOfflineActions({ storage: storage as never })

    expect(postBeef).not.toHaveBeenCalled()
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, rejected: 0 })
  })
})

// A nearby payment is broadcast by whichever side has signal first — routinely
// the PAYEE — so the payer's own request is still 'nosend' for a transaction the
// network already has. Re-posting it produced a broadcaster error that read as
// serviceError, and the queue row sat at 'queued' on every tick while the
// activity list said settled (2026-09-16). Two witnesses close the row instead.
describe('a transaction the network already has', () => {
  it('closes a queue row on a recorded delivery before asking whether it is online', async () => {
    ;(getOnline as jest.Mock).mockResolvedValueOnce(false)
    const tx = tokenTxSpending('55'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'settled', 'sent')
    // Storage already records the broadcast.
    const api = req({ txid, rawTx: tx.toBinary(), status: 'unmined' })
    const db = fakeDb([row({ txid, role: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r).toMatchObject({ sent: 1, rejected: 0, stopped: false })
    // Closed before the probe: nothing about it needed the network.
    expect(getOnline).not.toHaveBeenCalled()
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(db.writes.some(w => w.params.includes('sent'))).toBe(true)
  })

  it('records an owned request as delivered when the network has it, without posting', async () => {
    const tx = txSpending('44'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    const db = fakeDb([row({ txid, role: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'known' }, proven: [txid] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r).toMatchObject({ sent: 1, rejected: 0 })
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith(1, { status: 'unmined' })
    expect(db.writes.some(w => w.params.includes('sent'))).toBe(true)
  })

  // XQ-009: a status endpoint can claim 'known'/'mined' for a txid it has no
  // proof for. Without a validated Merkle path behind it, that claim must never
  // skip this device's own broadcast.
  it('does not skip the post when the network claims delivery but no proof backs it up', async () => {
    const tx = txSpending('45'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const db = fakeDb([row({ txid, role: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'known' } })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ sent: 1, rejected: 0 })
  })

  it('still holds an unsettled 1Color tip even when the network has it proven', async () => {
    const tx = tokenTxSpending('33'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'held')
    const api = req({ txid, rawTx: tx.toBinary() })
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'mined' }, proven: [txid] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).not.toHaveBeenCalled()
    expect(r.sent).toBe(0)
  })

  it('closes a settled 1Color tip on the network witness without posting', async () => {
    const tx = tokenTxSpending('34'.repeat(32))
    const txid = tx.id('hex')
    await journalRow(txid, 'settled')
    const api = req({ txid, rawTx: tx.toBinary() })
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'mined' }, proven: [txid] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 1 })
  })

  it('does not re-post a foreign ancestor the network has, and releases the child behind it', async () => {
    const parent = new Transaction()
    parent.addOutput({ satoshis: 2000, lockingScript: LockingScript.fromHex('51') })
    const parentTxid = parent.id('hex')
    const child = txSpending(parentTxid)
    const childTxid = child.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeRawTx(parent.toBinary())

    const api = req({ txid: childTxid, rawTx: child.toBinary(), inputBEEF: inputBEEF.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid: childTxid, status: 'success' }] }
    })
    const postBeef = jest.fn(async () => [])
    const db = fakeDb([row({ txid: childTxid, role: 'sent' })])
    const storage = fakeStorage({
      db,
      reqs: [api],
      postBeef,
      networkHas: { [parentTxid]: 'known' },
      proven: [parentTxid]
    })

    const r = await processOfflineActions({ storage: storage as never })

    expect(postBeef).not.toHaveBeenCalled()
    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ sent: 1, rejected: 0, stopped: false })
  })
})

// XQ-009 remainder: a 'sent' row whose backing request the toolbox's own
// proof-timeout later reclaimed is brought back in line, locally, before the
// probe.
describe('XQ-009 remainder: reconciling a stale sent row', () => {
  it("moves a 'sent' row to rejected once its backing request has gone invalid", async () => {
    const tx = txSpending('77'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary(), status: 'invalid' })
    const db = fakeDb([row({ txid, role: 'sent', status: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r).toMatchObject({ sent: 0, rejected: 1 })
    expect(
      db.writes.some(w => w.sql.includes('offline_actions') && w.params.includes('rejected') && w.params.includes(txid))
    ).toBe(true)
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).not.toHaveBeenCalled()
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
  })

  it("leaves a 'sent' row alone while its backing request is still undecided", async () => {
    const tx = txSpending('78'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary(), status: 'unmined' })
    const db = fakeDb([row({ txid, role: 'sent', status: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r).toMatchObject({ sent: 0, rejected: 0 })
    expect(db.writes.some(w => w.params.includes('rejected'))).toBe(false)
  })

  it('reconciles a stale sent row even while offline, before anything asks about connectivity', async () => {
    ;(getOnline as jest.Mock).mockResolvedValueOnce(false)
    const tx = txSpending('79'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary(), status: 'invalid' })
    const db = fakeDb([row({ txid, role: 'sent', status: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(r.rejected).toBe(1)
    expect(getOnline).not.toHaveBeenCalled()
  })
})
