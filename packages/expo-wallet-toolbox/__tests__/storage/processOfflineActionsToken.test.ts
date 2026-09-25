/**
 * The one branch `processOfflineActions` grows for token settlement.
 *
 * What is pinned here is the SEAM, not the drain's own logic (that is
 * `__tests__/mandala/drain.test.ts`): a step whose txid has a
 * `token_settlements` row must go through `postTokenStep` and must NOT reach
 * `postOwned`/`postForeign` on its own, while a plain BSV step must be
 * completely untouched by the feature. The outcome `postTokenStep` returns then
 * feeds the existing `applyOutcome`/cascade/requeue with no token-specific
 * handling anywhere downstream — which is what lets a refused ancestor cascade
 * through descendants that were never token rows.
 */
jest.mock('../../core/net/online', () => ({ getOnline: jest.fn(async () => true) }))

const mockPostReqs = jest.fn()
jest.mock('@bsv/wallet-toolbox-mobile', () => ({
  ...jest.requireActual('@bsv/wallet-toolbox-mobile'),
  attemptToPostReqsToNetwork: (...args: unknown[]) => mockPostReqs(...args)
}))

import { DatabaseSync } from 'node:sqlite'
import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import type { TableProvenTxReq } from '@bsv/wallet-toolbox-mobile'
import { processOfflineActions } from '../../core/storage/methods/processOfflineActions'
import { getOnline } from '../../core/net/online'
import type { BindValue, OfflineActionRow } from '../../core/storage/methods/offlineActions'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import type { CoverResult, OverlayVerdict, SettlementStore } from '../../core/mandala/types'

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

const OVERLAY = 'https://overlay.issuer.example'
const OVERLAY_KEY = '02' + 'cd'.repeat(32)
const ASSET_ID = 'ab'.repeat(32) + '.0'

function txSpending(sourceTXID: string): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis: 1000, lockingScript: LockingScript.fromHex('51') })
  return tx
}

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
    getAllAsync: async () => rows,
    runAsync: async (sql: string, params: BindValue[]) => {
      writes.push({ sql, params })
    },
    getFirstAsync: async () => undefined
  }
}

/** XQ-009: the block height every fake proof below claims. Arbitrary. */
const FAKE_PROOF_HEIGHT = 700_000

function fakeStorage(args: {
  db: ReturnType<typeof fakeDb>
  reqs: TableProvenTxReq[]
  postBeef?: jest.Mock
  /** What the network says it holds, by txid. Anything unlisted is 'unknown'. */
  networkHas?: Record<string, 'mined' | 'known'>
  /**
   * XQ-009: txids the fake chain tracker actually validates a Merkle root
   * for — a genuine (if minimal, single-leaf) proof, not merely a status
   * claim. A single-leaf MerklePath's root equals the txid itself, so
   * `isValidRootForHeight` below just checks membership. A txid present in
   * `networkHas` but absent here exercises exactly the gap XQ-009 closes:
   * the status service claims delivery, but no proof backs it up.
   */
  proven?: string[]
}) {
  return {
    sqliteDb: args.db,
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
      // A genuine, if minimal, chain-tracker-validated proof for exactly the
      // txids `proven` names — everything else gets no Merkle path at all,
      // matching a proof provider that has never seen this txid either.
      getChainTracker: async () => ({
        isValidRootForHeight: async (root: string, height: number) =>
          height === FAKE_PROOF_HEIGHT && (args.proven ?? []).includes(root)
      }),
      getMerklePath: async (txid: string) =>
        (args.proven ?? []).includes(txid)
          ? {
              merklePath: { blockHeight: FAKE_PROOF_HEIGHT, path: [[{ offset: 0, hash: txid, txid: true }]] },
              // EntityProvenTx.fromTxid only accepts a Merkle path alongside
              // a full header — a single-leaf path's root equals the txid,
              // so merkleRoot is set to that. Format/proof-of-work are not
              // validated on this call (fromTxid passes both flags false),
              // only presence and basic shape.
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

let raw: DatabaseSync
let store: SettlementStore
let log: jest.SpyInstance

beforeEach(async () => {
  mockPostReqs.mockReset()
  ;(getOnline as jest.Mock).mockReset().mockResolvedValue(true)
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  store = createSettlementStore(adapt(raw) as unknown as SettlementDb)
  log = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  raw.close()
})

async function seedSettlement(txid: string) {
  await store.upsertSettlement({
    txid,
    role: 'received',
    assetId: ASSET_ID,
    state: 'held',
    overlayUrl: OVERLAY,
    overlayIdentityKey: OVERLAY_KEY
  })
}

const admitted = (): OverlayVerdict => ({
  kind: 'admitted',
  outputsToAdmit: [0],
  signatureHex: '3045',
  signerKey: OVERLAY_KEY
})

describe('processOfflineActions token branch', () => {
  it('submits before broadcasting a step that has a settlement row', async () => {
    const tx = txSpending('11'.repeat(32))
    const txid = tx.id('hex')
    await seedSettlement(txid)

    const api = req({ txid, rawTx: tx.toBinary() })
    const order: string[] = []
    mockPostReqs.mockImplementation(async () => {
      order.push('broadcast')
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const submit = jest.fn(async (t: string) => {
      order.push(`submit:${t}`)
      return admitted()
    })

    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({
      storage: storage as never,
      token: { store, cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }), submit }
    })

    expect(order).toEqual([`submit:${txid}`, 'broadcast'])
    expect(r.sent).toBe(1)
    expect((await store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('leaves a plain BSV step entirely alone', async () => {
    const tx = txSpending('22'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const submit = jest.fn(async () => admitted())

    const storage = fakeStorage({ db: fakeDb([row({ txid })]), reqs: [api] })
    const r = await processOfflineActions({
      storage: storage as never,
      token: { store, cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }), submit }
    })

    expect(submit).not.toHaveBeenCalled()
    expect(r.sent).toBe(1)
  })

  it('never broadcasts when the overlay refuses, and cascades through the unchanged applyOutcome', async () => {
    const tx = txSpending('33'.repeat(32))
    const txid = tx.id('hex')
    await seedSettlement(txid)

    const api = req({ txid, rawTx: tx.toBinary() })
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({
      storage: storage as never,
      token: {
        store,
        cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }),
        submit: async (): Promise<OverlayVerdict> => ({ kind: 'refused', code: 'ERR_CONSERVATION' })
      }
    })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r.rejected).toBe(1)
    expect(await store.getSettlement(txid)).toMatchObject({ state: 'refused', refusedCode: 'ERR_CONSERVATION' })
    // The queue row is rejected by the existing cascade, not by anything new.
    expect(db.writes.some(w => w.params.includes('rejected'))).toBe(true)
  })

  it('leaves the row queued and non-terminal when the overlay is unavailable', async () => {
    const tx = txSpending('44'.repeat(32))
    const txid = tx.id('hex')
    await seedSettlement(txid)

    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [req({ txid, rawTx: tx.toBinary() })] })

    const r = await processOfflineActions({
      storage: storage as never,
      token: {
        store,
        cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }),
        submit: async (): Promise<OverlayVerdict> => ({ kind: 'unavailable', code: 'ERR_PAUSED', retryable: true })
      }
    })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r.rejected).toBe(0)
    expect((await store.getSettlement(txid))?.state).toBe('held')
    expect(db.writes.at(-1)?.params).toContain('queued')
  })

  // FIX G / FIX I: the reconciliation pass runs before anything else, so a
  // frame whose settlement row was never written still gets one.
  it('re-derives evidence and settlement rows before the plan runs', async () => {
    const tx = txSpending('55'.repeat(32))
    const txid = tx.id('hex')
    const storage = fakeStorage({ db: fakeDb([]), reqs: [] })

    await processOfflineActions({
      storage: storage as never,
      token: {
        store,
        cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }),
        submit: async () => admitted(),
        frames: async () => [
          {
            txid,
            role: 'received' as const,
            frame: {
              kind: 'token',
              transaction: new Uint8Array([0]),
              token: {
                assetId: ASSET_ID,
                overlayUrl: OVERLAY,
                overlayIdentityKey: OVERLAY_KEY,
                linkage: [{ txid: 'ff'.repeat(32), payload: new Uint8Array([1, 2]) }]
              }
            }
          }
        ]
      }
    })

    expect(await store.getSettlement(txid)).toMatchObject({ state: 'held', assetId: ASSET_ID })
    expect(await store.getLinkage('ff'.repeat(32))).toBeDefined()
  })

  // A thrown settlement read used to collapse to `undefined`, which the caller
  // cannot tell from "there is no row, this is an ordinary BSV transaction" —
  // so a locked database sent an unadmitted token tip straight to broadcast,
  // defeating the whole §4.3 gate on exactly the transient fault the drain is
  // built to survive. "I could not tell" must never resolve to "go ahead".
  it('stalls the step when the settlement read throws, and never broadcasts', async () => {
    const tx = txSpending('77'.repeat(32))
    const txid = tx.id('hex')
    await seedSettlement(txid)

    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const submit = jest.fn(async () => admitted())
    const postBeef = jest.fn(async () => [])
    const broken: SettlementStore = {
      ...store,
      getSettlement: async () => {
        throw new Error('database is locked')
      }
    }

    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api], postBeef })
    const r = await processOfflineActions({
      storage: storage as never,
      token: { store: broken, cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }), submit }
    })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(postBeef).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(r.sent).toBe(0)
    expect(r.rejected).toBe(0)
    // serviceError, so the row is left for the next pass rather than burned.
    expect(db.writes.some(w => w.params.includes('rejected'))).toBe(false)
    expect((await store.getSettlement(txid))?.state).toBe('held')
  })

  it('works exactly as before when no token deps are supplied at all', async () => {
    const tx = txSpending('66'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const storage = fakeStorage({ db: fakeDb([row({ txid })]), reqs: [api] })

    await expect(processOfflineActions({ storage: storage as never })).resolves.toMatchObject({ sent: 1 })
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
    const tx = txSpending('55'.repeat(32))
    const txid = tx.id('hex')
    await store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'admitted',
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY
    })
    // settleNow posted this at hand-over: storage already says so.
    const api = req({ txid, rawTx: tx.toBinary(), status: 'unmined' })
    const db = fakeDb([row({ txid, role: 'sent' })])
    const storage = fakeStorage({ db, reqs: [api] })

    const r = await processOfflineActions({
      storage: storage as never,
      token: { store, cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }), submit: jest.fn() }
    })

    expect(r).toMatchObject({ sent: 1, rejected: 0, stopped: false })
    // Closed before the probe: nothing about it needed the network.
    expect(getOnline).not.toHaveBeenCalled()
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(db.writes.some(w => w.params.includes('sent'))).toBe(true)
    expect((await store.getSettlement(txid))?.state).toBe('broadcast')
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

  // XQ-009: the exact gap the fix closes — a status endpoint (compromised, or
  // simply lying) can claim 'known'/'mined' for a txid it has no proof for.
  // Without a validated Merkle path behind it, that claim must never skip
  // this device's own broadcast.
  it('does not skip the post when the network claims delivery but no proof backs it up', async () => {
    const tx = txSpending('45'.repeat(32))
    const txid = tx.id('hex')
    const api = req({ txid, rawTx: tx.toBinary() })
    mockPostReqs.mockImplementation(async () => {
      api.status = 'unmined'
      return { details: [{ txid, status: 'success' }] }
    })
    const db = fakeDb([row({ txid, role: 'sent' })])
    // 'known', but NOT in `proven` — no Merkle path a chain tracker would
    // accept backs this claim up.
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'known' } })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ sent: 1, rejected: 0 })
  })

  it('still gates a token tip on admission, then closes it on the network witness', async () => {
    const tx = txSpending('33'.repeat(32))
    const txid = tx.id('hex')
    await seedSettlement(txid)
    const api = req({ txid, rawTx: tx.toBinary() })
    const submit = jest.fn(async () => admitted())
    const db = fakeDb([row({ txid })])
    const storage = fakeStorage({ db, reqs: [api], networkHas: { [txid]: 'mined' }, proven: [txid] })

    const r = await processOfflineActions({
      storage: storage as never,
      token: { store, cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [txid] }), submit }
    })

    expect(submit).toHaveBeenCalledWith(txid)
    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 1 })
    expect((await store.getSettlement(txid))?.state).toBe('broadcast')
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
