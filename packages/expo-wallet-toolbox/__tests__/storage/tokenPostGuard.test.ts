/**
 * Guard #2 and guard #3: the broadcast hold for 1Color transactions (plan 07
 * W1, IC §8.2 host broadcast guard), keyed on the wallet's `color_transfers`
 * journal.
 *
 * `attemptToPostReqsToNetwork` is the override `shareReqsWithWorld` reaches —
 * which covers `internalizeAction`'s forced broadcast, the non-delayed
 * create/`sendWith` path, and the color module's post-admission
 * `sendWith:[txid]` (IC D24). It has always held requests only when OFFLINE.
 * That is exactly the "common shop case: payee has Wi-Fi, payer none" hole: an
 * ONLINE recipient internalizing a token receipt reached a real, unmediated
 * broadcast with no admission gate at all.
 *
 * So: a request whose raw tx carries a BRC-162 1Color output AND this
 * wallet's token custody (a journal row, a Mandala host-ledger record, or a
 * spent `p color` input) is held, regardless of connectivity, unless its
 * journal row reads `settled`. A missing row holds a receipt the host ledger
 * recorded. Only the remaining requests take the online branch. (A 1Color
 * output with no custody of ours is a decoy and is not held:
 * `decoyOutputHold.test.ts`.) Here TOKEN_TX is a receipt being credited: the
 * lib's receive path recorded it in the host ledger before internalizing.
 * Guard #3 falls out of that — `TaskSendWaiting` selects `['unsent','sending']`
 * directly, bypassing this override entirely, so the rule that protects it is
 * that a held token req never reaches either status in the first place. That
 * is asserted here rather than fixed with a third code change.
 */
const mockGetOnline = jest.fn(async () => true)
jest.mock('../../core/net/online', () => ({ getOnline: () => mockGetOnline() }))

import { DatabaseSync } from 'node:sqlite'
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'
import { createTransferJournal, type JournalDb } from '../../core/mandala/transferJournal'
import { HOST_LEDGER_RECORD_PREFIX } from '../../core/mandala/colorGuard'
import type { ColorTransferState } from '../../core/mandala/types'
import { findOfflineActions } from '../../core/storage/methods/offlineActions'

const ASSET_ID = 'ab'.repeat(32) + '_0'
const PKH = PrivateKey.fromRandom().toPublicKey().toHash() as number[]

function txWith(lockingScript: LockingScript, salt: string): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: salt.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript })
  return tx
}

const TOKEN_TX = txWith(new OneColor().lock(ASSET_ID, 1500n, PKH), '11')
const BSV_TX = txWith(new P2PKH().lock(PKH), '22')
const TOKEN_TXID = TOKEN_TX.id('hex')
const BSV_TXID = BSV_TX.id('hex')
const RAW: Record<string, number[]> = { [TOKEN_TXID]: TOKEN_TX.toBinary(), [BSV_TXID]: BSV_TX.toBinary() }

/** The statuses `TaskSendWaiting` selects — a token req must never be at one. */
const MONITOR_SELECTS = ['unsent', 'sending']

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    }
  }
}

const reqOf = (txid: string, provenTxReqId: number) =>
  ({ txid, provenTxReqId, status: 'unsent', rawTx: RAW[txid], notify: { transactionIds: [provenTxReqId] } }) as never

/** The table shape `processUnsent` hands `holdTokenReqsForDrain`: `notify` is stored JSON. */
const tableReqOf = (txid: string, provenTxReqId: number) =>
  ({
    txid,
    provenTxReqId,
    status: 'unsent',
    rawTx: RAW[txid],
    history: '{}',
    notify: JSON.stringify({ transactionIds: [provenTxReqId] })
  }) as never

class TestStorage extends StorageExpoSQLite {
  reqStatuses = new Map<number, string>()
  constructor(public readonly conn: ReturnType<typeof adapt>) {
    super({ chain: 'test' } as never)
    this.db = conn as never
  }
  async findProvenTxReqs(a: { partial: { txid?: string } }): Promise<never[]> {
    const id = a.partial.txid === TOKEN_TXID ? 1 : 2
    return [
      {
        provenTxReqId: id,
        txid: a.partial.txid,
        rawTx: a.partial.txid ? RAW[a.partial.txid] : undefined,
        status: this.reqStatuses.get(id) ?? 'unsent'
      }
    ] as never
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

async function journalRow(txid: string, state: ColorTransferState) {
  await createTransferJournal(adapt(raw) as unknown as JournalDb).insert({
    txid,
    role: 'received',
    assetId: ASSET_ID,
    units: 1500n,
    outputIndex: 0,
    rail: 'nearby',
    state,
    delivered: false
  })
}

/** Make every read of the journal table throw, as a locked database would. */
function breakJournalReads() {
  const original = storage.conn.getAllAsync.bind(storage.conn)
  return jest.spyOn(storage.conn, 'getAllAsync').mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('color_transfers')) throw new Error('SQLITE_BUSY: database is locked')
    return original(sql, params)
  })
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  const conn = adapt(raw)
  await createTables(conn as never)
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (7,'n','n','k')`).run()

  storage = new TestStorage(conn)
  // TOKEN_TX is a receipt the host verified and recorded before internalizing it.
  await storage.setKeyValue(
    HOST_LEDGER_RECORD_PREFIX + TOKEN_TXID,
    JSON.stringify({ v: 1, txid: TOKEN_TXID, assetId: ASSET_ID, state: 'pending', outputs: [0], at: 1 })
  )
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

describe('guard #2: an unsettled 1Color req is held regardless of connectivity', () => {
  it('holds an ONLINE 1Color receipt with no journal row instead of broadcasting it', async () => {
    const r = await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])

    expect(superPost).not.toHaveBeenCalled()
    expect(r.details.map(d => d.txid)).toEqual([TOKEN_TXID])
    expect(await findOfflineActions(storage.sqliteDb as never, {})).toEqual([
      expect.objectContaining({ txid: TOKEN_TXID, status: 'queued' })
    ])
  })

  it.each(['held', 'handed_over', 'built'] as const)('holds an ONLINE 1Color req whose row reads %s', async state => {
    await journalRow(TOKEN_TXID, state)
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    expect(superPost).not.toHaveBeenCalled()
  })

  it('posts a 1Color req once its journal row is settled', async () => {
    await journalRow(TOKEN_TXID, 'settled')
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])

    expect(superPost).toHaveBeenCalledTimes(1)
    expect((superPost.mock.calls[0][0] as { txid: string }[]).map(r => r.txid)).toEqual([TOKEN_TXID])
    expect(await findOfflineActions(storage.sqliteDb as never, {})).toEqual([])
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

  it('never consults connectivity at all when every req is a held token req', async () => {
    mockGetOnline.mockClear()
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    expect(mockGetOnline).not.toHaveBeenCalled()
  })

  it('holds a req whose raw transaction will not parse', async () => {
    const garbled = { txid: BSV_TXID, provenTxReqId: 2, status: 'unsent', rawTx: [1, 2, 3], notify: {} } as never
    await storage.attemptToPostReqsToNetwork([garbled])
    expect(superPost).not.toHaveBeenCalled()
  })

  // XR-045: a broken database must not silently become a broadcast. Whether the
  // table is simply missing or the read throws for some other reason, the batch
  // is held, never posted.
  it('holds rather than posts when the journal table cannot be read at all', async () => {
    raw.exec('DROP TABLE color_transfers')
    await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1)])
    expect(superPost).not.toHaveBeenCalled()
  })

  it('XR-045: a genuine read fault — not merely a missing table — holds the WHOLE batch, never posts', async () => {
    // The row says settled: the fault is in the READ, not in the data, which is
    // exactly what must never be misread as "go ahead".
    await journalRow(TOKEN_TXID, 'settled')
    const getAllAsync = breakJournalReads()

    const r = await storage.attemptToPostReqsToNetwork([reqOf(TOKEN_TXID, 1), reqOf(BSV_TXID, 2)])

    expect(superPost).not.toHaveBeenCalled()
    // The caller's result must still cover every txid it handed in, or
    // `internalizeAction` rolls back a payment that was actually accepted.
    expect(r.details.map(d => d.txid).sort()).toEqual([TOKEN_TXID, BSV_TXID].sort())
    getAllAsync.mockRestore()
    expect((await findOfflineActions(storage.sqliteDb as never, {})).map(x => x.txid).sort()).toEqual(
      [TOKEN_TXID, BSV_TXID].sort()
    )
  })
})

/**
 * Guard #2's RESULT half — the 2026-09-15 cause, one layer up.
 *
 * A held token request answers `status: 'success'` because that is what
 * "accepted for delivery" is spelled as, and what stops `internalizeAction`
 * rolling back a payment it verified. But `aggregateActionResults` turns that
 * into `SendWithResult.status = 'unproven'` — "the processing network has
 * accepted this transaction" — and a caller that believes it (on 2026-09-15,
 * `@bsv/mandala`'s `broadcastAcceptedTx`) clears its record of a transaction
 * nothing had broadcast.
 *
 * So a held token txid is OMITTED from `sendWithResults` rather than reported
 * as delivered. Omission and not an invented status: `Wallet.createAction`
 * throws `WERR_REVIEW_ACTIONS` unless every entry reads `'unproven'`, so a
 * fourth value would turn a correct hold into a thrown error for every caller,
 * while an absent entry simply does not claim the transaction went out. The
 * color module reads the absence as success too (IC D24: only a `'failed'`
 * entry is an `unsent` marker).
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
    superProcess.mockRestore()
  })

  it('reports a settled token txid parked at nosend exactly as the toolbox produced it', async () => {
    storage.reqStatuses.set(1, 'nosend')
    await journalRow(TOKEN_TXID, 'settled')
    const swr = [{ txid: TOKEN_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual(swr)
    superProcess.mockRestore()
  })

  it('leaves a plain BSV result exactly as the toolbox produced it', async () => {
    storage.reqStatuses.set(2, 'nosend')
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

  it('reports a token txid that has really been broadcast exactly as before', async () => {
    // Past 'nosend' is past the hold: the release really happened, so nothing
    // is withheld.
    storage.reqStatuses.set(1, 'unmined')
    const swr = [{ txid: TOKEN_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual(swr)
    superProcess.mockRestore()
  })

  // XR-045/SEC2-070: an indeterminate classification must fail closed the same
  // way the broadcast guard does on the identical read fault: every txid is
  // treated as if held, so every entry is omitted rather than reported as sent.
  it('XR-045/SEC2-070: omits every entry when the journal table cannot be read', async () => {
    storage.reqStatuses.set(1, 'nosend')
    raw.exec('DROP TABLE color_transfers')
    const swr = [{ txid: TOKEN_TXID, status: 'unproven' }]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [TOKEN_TXID] } as never)

    expect(r.sendWithResults).toEqual([])
    superProcess.mockRestore()
  })

  it('XR-045/SEC2-070: a mixed batch is entirely withheld too — the fault means neither txid can be classified', async () => {
    storage.reqStatuses.set(1, 'nosend')
    storage.reqStatuses.set(2, 'nosend')
    const getAllAsync = breakJournalReads()
    const swr = [
      { txid: TOKEN_TXID, status: 'unproven' },
      { txid: BSV_TXID, status: 'unproven' }
    ]
    const superProcess = jest
      .spyOn(StorageProvider.prototype, 'processAction')
      .mockResolvedValue({ sendWithResults: swr } as never)

    const r = await storage.processAction({ userId: 7 } as never, { sendWith: [] } as never)

    expect(r.sendWithResults).toEqual([])
    superProcess.mockRestore()
    getAllAsync.mockRestore()
  })
})

describe('guard #3: a held token req never reaches unsent/sending', () => {
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

/**
 * The monitor-retry half (`WalletContext`'s `processUnsent` patch): every
 * unsettled 1Color req is held for the drain and the caller is told which, so
 * it posts only the rest. Never throws.
 */
describe('holdTokenReqsForDrain', () => {
  it('holds and names only the unsettled 1Color reqs', async () => {
    const held = await storage.holdTokenReqsForDrain([tableReqOf(TOKEN_TXID, 1), tableReqOf(BSV_TXID, 2)])
    expect(held).toEqual(new Set([TOKEN_TXID]))
    expect(storage.reqStatuses.get(1)).toBe('nosend')
    expect(storage.reqStatuses.get(2)).toBeUndefined()
  })

  it('names nothing once the 1Color req is settled', async () => {
    await journalRow(TOKEN_TXID, 'settled')
    expect(await storage.holdTokenReqsForDrain([tableReqOf(TOKEN_TXID, 1)])).toEqual(new Set())
  })

  it('withholds the whole batch on a journal read fault', async () => {
    const getAllAsync = breakJournalReads()
    expect(await storage.holdTokenReqsForDrain([tableReqOf(TOKEN_TXID, 1), tableReqOf(BSV_TXID, 2)])).toEqual(
      new Set([TOKEN_TXID, BSV_TXID])
    )
    getAllAsync.mockRestore()
  })
})

describe('colorHeldTxids (public)', () => {
  it('does not hold a 1Color tx with no custody of this wallet (a decoy output)', async () => {
    await storage.conn.runAsync('DELETE FROM key_value_store WHERE key = ?', [HOST_LEDGER_RECORD_PREFIX + TOKEN_TXID])
    expect(await storage.colorHeldTxids([{ txid: TOKEN_TXID, rawTx: RAW[TOKEN_TXID] }])).toEqual(new Set())
  })

  it('reads this storage’s own journal', async () => {
    await journalRow(TOKEN_TXID, 'held')
    expect(
      await storage.colorHeldTxids([
        { txid: TOKEN_TXID, rawTx: RAW[TOKEN_TXID] },
        { txid: BSV_TXID, rawTx: RAW[BSV_TXID] }
      ])
    ).toEqual(new Set([TOKEN_TXID]))
  })
})
