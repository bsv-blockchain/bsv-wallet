/**
 * Guard #2 and guard #3 of the offline-settlement spec (§4.3).
 *
 * `attemptToPostReqsToNetwork` is the override `shareReqsWithWorld` reaches —
 * which covers `internalizeAction`'s forced broadcast and the non-delayed
 * create/`sendWith` path. It has always held requests only when OFFLINE. That
 * is exactly the "common shop case: payee has Wi-Fi, payer none" hole: an
 * ONLINE recipient internalizing a token frame reached a real, unmediated
 * broadcast with no admission gate at all.
 *
 * So: a request whose txid has a `token_settlements` row is held regardless of
 * connectivity, and only the remaining, non-token requests take the online
 * branch. Guard #3 falls out of that — `TaskSendWaiting` selects
 * `['unsent','sending']` directly, bypassing this override entirely, so the
 * rule that protects it is that a token req never reaches either status in the
 * first place. That is asserted here rather than fixed with a third code
 * change.
 */
const mockGetOnline = jest.fn(async () => true)
jest.mock('../../core/net/online', () => ({ getOnline: () => mockGetOnline() }))

import { DatabaseSync } from 'node:sqlite'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import { findOfflineActions } from '../../core/storage/methods/offlineActions'

const TOKEN_TXID = 'aa'.repeat(32)
const BSV_TXID = 'bb'.repeat(32)
const OVERLAY_KEY = '02' + 'cd'.repeat(32)

/** The statuses `TaskSendWaiting` selects — a token req must never be at one. */
const MONITOR_SELECTS = ['unsent', 'sending']

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

const reqOf = (txid: string, provenTxReqId: number) =>
  ({ txid, provenTxReqId, status: 'unsent', notify: { transactionIds: [provenTxReqId] } }) as never

class TestStorage extends StorageExpoSQLite {
  reqStatuses = new Map<number, string>()
  constructor(public readonly conn: ReturnType<typeof adapt>) {
    super({ chain: 'test' } as never)
    this.db = conn as never
  }
  async findProvenTxReqs(a: { partial: { txid?: string } }): Promise<never[]> {
    const id = a.partial.txid === TOKEN_TXID ? 1 : 2
    return [{ provenTxReqId: id, txid: a.partial.txid, status: this.reqStatuses.get(id) ?? 'unsent' }] as never
  }
  async updateProvenTxReq(id: number, patch: { status?: string }): Promise<number> {
    if (patch.status) this.reqStatuses.set(id, patch.status)
    return 1
  }
  async findTransactions(a: { partial: { transactionId?: number } }): Promise<never[]> {
    return [{ transactionId: a.partial.transactionId, userId: 7, isOutgoing: false, status: 'unproven' }] as never
  }
}

let raw: DatabaseSync
let storage: TestStorage
let superPost: jest.SpyInstance
let log: jest.SpyInstance

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  const conn = adapt(raw)
  await createTables(conn as never)
  const store = createSettlementStore(conn as unknown as SettlementDb)
  await store.upsertSettlement({
    txid: TOKEN_TXID,
    role: 'received',
    assetId: 'ab'.repeat(32) + '.0',
    state: 'held',
    overlayUrl: 'https://overlay.example',
    overlayIdentityKey: OVERLAY_KEY
  })
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (7,'n','n','k')`).run()

  storage = new TestStorage(conn)
  mockGetOnline.mockResolvedValue(true)
  const fakePost = (async (reqs: { txid: string }[]) => ({
    status: 'success',
    beef: undefined,
    details: reqs.map(r => ({ txid: r.txid, req: r, status: 'success' })),
    log: ''
  })) as never
  superPost = jest.spyOn(StorageProvider.prototype, 'attemptToPostReqsToNetwork').mockImplementation(fakePost)
  log = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  superPost.mockRestore()
  log.mockRestore()
  raw.close()
})

describe('guard #2: a token req is held regardless of connectivity', () => {
  it('holds an ONLINE token req instead of broadcasting it', async () => {
    const r = await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])

    expect(superPost).not.toHaveBeenCalled()
    expect(r.details.map(d => d.txid)).toEqual([TOKEN_TXID])
    expect(await findOfflineActions(storage.sqliteDb as never, {})).toEqual([
      expect.objectContaining({ txid: TOKEN_TXID, status: 'queued' })
    ])
  })

  it('lets a plain BSV req take the online branch untouched', async () => {
    await storage.attemptToPostReqsToNetwork([reqOf(BSV_TXID, 2)])

    expect(superPost).toHaveBeenCalledTimes(1)
    expect((superPost.mock.calls[0][0] as { txid: string }[]).map(r => r.txid)).toEqual([BSV_TXID])
    expect(await findOfflineActions(storage.sqliteDb as never, {})).toEqual([])
  })

  it('splits a mixed batch: the token req is held, only the rest is posted', async () => {
    const r = await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1), reqOf(BSV_TXID, 2)])

    expect((superPost.mock.calls[0][0] as { txid: string }[]).map(x => x.txid)).toEqual([BSV_TXID])
    // The caller's result must still cover every txid it handed in, or
    // `internalizeAction` rolls back a payment that was actually accepted.
    expect(r.details.map(d => d.txid).sort()).toEqual([TOKEN_TXID, BSV_TXID].sort())
    expect((await findOfflineActions(storage.sqliteDb as never, {})).map(x => x.txid)).toEqual([TOKEN_TXID])
  })

  it('still holds everything when offline, token or not', async () => {
    mockGetOnline.mockResolvedValue(false)
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1), reqOf(BSV_TXID, 2)])

    expect(superPost).not.toHaveBeenCalled()
    expect((await findOfflineActions(storage.sqliteDb as never, {})).map(x => x.txid).sort()).toEqual(
      [TOKEN_TXID, BSV_TXID].sort()
    )
  })

  it('never consults connectivity at all when every req is a token req', async () => {
    mockGetOnline.mockClear()
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    expect(mockGetOnline).not.toHaveBeenCalled()
  })

  // A broken or pre-migration database must not silently become a broadcast.
  it('falls back to the pre-feature behaviour when the settlement table cannot be read', async () => {
    raw.exec('DROP TABLE token_settlements')
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    expect(superPost).toHaveBeenCalledTimes(1)
  })
})

/**
 * Guard #2's RESULT half — the 2026-09-15 cause, one layer up.
 *
 * A held token request answers `status: 'success'` because that is what
 * "accepted for delivery" is spelled as, and what stops `internalizeAction`
 * rolling back a payment it verified. But `aggregateActionResults` turns that
 * into `SendWithResult.status = 'unproven'` — "the processing network has
 * accepted this transaction" — and `@bsv/mandala`'s `broadcastAcceptedTx`
 * believed it, cleared the `'accepted'` journal entry for a transaction nothing
 * had broadcast, and so left a live noSend action looking abandoned to the next
 * sweep. One aborted action and one released-but-spent coin later, that is the
 * incident.
 *
 * So a held token txid is OMITTED from `sendWithResults` rather than reported
 * as delivered. Omission and not an invented status: `Wallet.createAction`
 * throws `WERR_REVIEW_ACTIONS` unless every entry reads `'unproven'`, so a
 * fourth value would turn a correct hold into a thrown error for every caller,
 * while an absent entry simply does not claim the transaction went out.
 */
describe('guard #2, result shape: a held token req never reports as sent', () => {
  it('omits a held token txid rather than calling it unproven or sending', async () => {
    storage.reqStatuses.set(1, 'nosend')
    const superProcess = jest.spyOn(StorageProvider.prototype, 'processAction').mockResolvedValue({
      sendWithResults: [{ txid: TOKEN_TXID, status: 'unproven' }],
      notDelayedResults: [{ txid: TOKEN_TXID, status: 'success' }]
    } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual([])
    // Never reported as either of the two statuses a caller reads as delivered.
    for (const entry of r.sendWithResults ?? []) {
      expect(['unproven', 'sending']).not.toContain(entry.status)
    }
    superProcess.mockRestore()
  })

  it('leaves a plain BSV result exactly as the toolbox produced it', async () => {
    const swr = [{ txid: BSV_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [BSV_TXID] } as never)

    expect(r.sendWithResults).toEqual(swr)
    superProcess.mockRestore()
  })

  it('splits a mixed batch — only the held token txid is withheld', async () => {
    storage.reqStatuses.set(1, 'nosend')
    const superProcess = jest.spyOn(StorageProvider.prototype, 'processAction').mockResolvedValue({
      sendWithResults: [
        { txid: TOKEN_TXID, status: 'unproven' },
        { txid: BSV_TXID, status: 'sending' }
      ]
    } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [] } as never)

    expect(r.sendWithResults).toEqual([{ txid: BSV_TXID, status: 'sending' }])
    superProcess.mockRestore()
  })

  it('reports a token txid the DRAIN has really broadcast exactly as before', async () => {
    // Past 'nosend' is past the hold: `postTokenStep` owns this broadcast and
    // it actually happened, so nothing is withheld.
    storage.reqStatuses.set(1, 'unmined')
    const swr = [{ txid: TOKEN_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual(swr)
    superProcess.mockRestore()
  })

  it('changes nothing when the settlement table cannot be read', async () => {
    storage.reqStatuses.set(1, 'nosend')
    raw.exec('DROP TABLE token_settlements')
    const swr = [{ txid: TOKEN_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual(swr)
    superProcess.mockRestore()
  })
})

describe('guard #3: a token req never reaches unsent/sending', () => {
  it('leaves the held token request at nosend, the one status no monitor task sends', async () => {
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])

    expect(storage.reqStatuses.get(1)).toBe('nosend')
    expect(MONITOR_SELECTS).not.toContain(storage.reqStatuses.get(1))
  })

  it('holds it again, idempotently, on a second forced broadcast', async () => {
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])

    expect(superPost).not.toHaveBeenCalled()
    expect(storage.reqStatuses.get(1)).toBe('nosend')
    expect(await findOfflineActions(storage.sqliteDb as never, {})).toHaveLength(1)
  })
})
