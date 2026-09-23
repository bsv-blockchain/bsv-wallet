/**
 * The settlement row is written BEFORE `internalizeAction`, not after
 * (offline-settlement spec §4.2, and §4.3's guard #2).
 *
 * Guard #2 — `StorageExpoSQLite.attemptToPostReqsToNetwork` holding any request
 * whose txid has a `token_settlements` row — is the only thing standing between
 * an online recipient and a real, unmediated broadcast of an unadmitted token
 * transaction. `internalizeAction` triggers exactly that broadcast itself, via
 * `shareReqsWithWorld`.
 *
 * So a row written by `onTokenCredited`, which runs AFTER the credit, is
 * written one call too late: on the FIRST internalize the guard looks up a
 * txid that has no row yet, finds nothing, and falls through. Every subsequent
 * pass is gated; the one that actually put the transaction on chain was not.
 * `onTokenHeld` closes it by running first.
 *
 * These tests use the REAL `StorageExpoSQLite` against real SQLite, with
 * NOTHING pre-seeded, because a pre-seeded row is precisely the assumption that
 * hid the hole.
 */
const mockGetOnline = jest.fn(async () => true)
jest.mock('../../core/net/online', () => ({ getOnline: () => mockGetOnline() }))

import { DatabaseSync } from 'node:sqlite'
import { Beef, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import { getPending, processPending, savePending, type KVStorage } from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import type { EvidenceFrame, SettlementStore } from '../../core/mandala/types'

const ASSET = 'ab'.repeat(32) + '.0'
const OVERLAY = 'https://overlay.issuer.example'
const OVERLAY_KEY = '03'.padEnd(66, 'b')
const PKH = new Array(20).fill(9)

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

function memoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

function tokenFrame(): { frame: PaymentFrame; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, 250, PKH) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  return {
    txid,
    frame: {
      version: FRAME_VERSION,
      kind: 'token',
      senderIdentityKey: '02'.padEnd(66, 'a'),
      outputIndex: 0,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      token: {
        assetId: ASSET,
        overlayUrl: OVERLAY,
        overlayIdentityKey: OVERLAY_KEY,
        certificates: [],
        linkage: [],
        admissions: []
      },
      transaction: new Uint8Array(beef.toBinaryAtomic(txid))
    }
  }
}

/** Real storage, with only the request/transaction lookups the guard path reads stubbed. */
class TestStorage extends StorageExpoSQLite {
  constructor(
    private readonly conn: ReturnType<typeof adapt>,
    private readonly tokenTxid: string
  ) {
    super({ chain: 'test' } as never)
    this.db = conn as never
  }
  async findProvenTxReqs(): Promise<never[]> {
    return [{ provenTxReqId: 1, txid: this.tokenTxid, status: 'unsent' }] as never
  }
  async updateProvenTxReq(): Promise<number> {
    return 1
  }
  async findTransactions(a: { partial: { transactionId?: number } }): Promise<never[]> {
    return [{ transactionId: a.partial.transactionId ?? 1, userId: 7, isOutgoing: false, status: 'unproven' }] as never
  }
}

let raw: DatabaseSync
let conn: ReturnType<typeof adapt>
let storage: TestStorage
let store: SettlementStore
let superPost: jest.SpyInstance
let log: jest.SpyInstance
let warn: jest.SpyInstance

const TOKEN = tokenFrame()

/**
 * The forced broadcast `internalizeAction` performs, reduced to the one call
 * that matters: `shareReqsWithWorld` → `attemptToPostReqsToNetwork`.
 */
function internalizingWallet(order: string[]) {
  return {
    internalizeAction: async () => {
      order.push('internalize')
      await storage.attemptToPostReqsToNetwork([
        { txid: TOKEN.txid, provenTxReqId: 1, status: 'unsent', notify: { transactionIds: [1] } } as never
      ])
      return { accepted: true }
    }
  }
}

/** Exactly what the Mandala runtime's `onTokenHeld` does: row first, then evidence. */
const writeHeldRow = (order: string[]) => async (frame: EvidenceFrame, txid: string) => {
  order.push('held')
  await store.upsertSettlement({
    txid,
    role: 'received',
    assetId: frame.token!.assetId,
    state: 'held',
    overlayUrl: frame.token!.overlayUrl,
    overlayIdentityKey: frame.token!.overlayIdentityKey
  })
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  conn = adapt(raw)
  await createTables(conn as never)
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (7,'n','n','k')`).run()
  store = createSettlementStore(conn as unknown as SettlementDb)
  storage = new TestStorage(conn, TOKEN.txid)
  mockGetOnline.mockResolvedValue(true)
  superPost = jest.spyOn(StorageProvider.prototype, 'attemptToPostReqsToNetwork').mockImplementation((async (
    reqs: { txid: string }[]
  ) => ({
    status: 'success',
    beef: undefined,
    details: reqs.map(r => ({ txid: r.txid, req: r, status: 'success' })),
    log: ''
  })) as never)
  log = jest.spyOn(console, 'log').mockImplementation(() => {})
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  superPost.mockRestore()
  log.mockRestore()
  warn.mockRestore()
  raw.close()
})

describe('onTokenHeld: the row lands before the first internalize', () => {
  it('never reaches a real broadcast on the very first credit', async () => {
    const kv = memoryStorage()
    await savePending(kv, TOKEN.frame)
    const order: string[] = []

    const results = await processPending(
      internalizingWallet(order),
      kv,
      'test',
      undefined,
      undefined,
      writeHeldRow(order)
    )

    expect(results).toEqual([expect.objectContaining({ success: true })])
    // The whole point: the guard had a row to find when it looked.
    expect(superPost).not.toHaveBeenCalled()
    expect(order).toEqual(['held', 'internalize'])
    expect(await store.getSettlement(TOKEN.txid)).toMatchObject({ state: 'held', role: 'received' })
  })

  // The regression this closes, stated as the behaviour it replaces. With the
  // row written only after the credit, the first internalize's forced
  // broadcast goes through unmediated — which is the "payee has Wi-Fi, payer
  // none" shop case, every time.
  it('the after-the-credit hook alone would have let that broadcast through', async () => {
    const kv = memoryStorage()
    await savePending(kv, TOKEN.frame)
    const order: string[] = []

    await processPending(internalizingWallet(order), kv, 'test', undefined, writeHeldRow(order))

    expect(superPost).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['internalize', 'held'])
  })

  it('leaves the BSV path with no settlement write at all', async () => {
    const kv = memoryStorage()
    const tx = new Transaction()
    tx.addOutput({ satoshis: 4200, lockingScript: new MandalaToken().lock(ASSET, 1, PKH) })
    const beef = new Beef()
    beef.mergeTransaction(tx)
    await savePending(kv, { ...TOKEN.frame, kind: 'bsv', token: undefined })
    const order: string[] = []

    await processPending(internalizingWallet(order), kv, 'test', undefined, undefined, writeHeldRow(order))

    expect(order).toEqual(['internalize'])
  })

  it('is optional: a caller that wires neither hook still drains', async () => {
    const kv = memoryStorage()
    await savePending(kv, TOKEN.frame)
    const order: string[] = []
    await expect(processPending(internalizingWallet(order), kv, 'test')).resolves.toEqual([
      expect.objectContaining({ success: true })
    ])
  })
})

describe('onTokenHeld: a failed pre-write refuses to credit', () => {
  it('does not internalize, and does not burn an attempt (FIX I)', async () => {
    const kv = memoryStorage()
    await savePending(kv, TOKEN.frame)
    const order: string[] = []

    const results = await processPending(internalizingWallet(order), kv, 'test', undefined, undefined, async () => {
      throw new Error('database is locked')
    })

    expect(order).toEqual([])
    expect(superPost).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ success: false })
    expect(String(results[0].error)).toMatch(/settlement row before crediting/)

    // The frame is durable and the money is real: a local storage fault is a
    // header-lag-class failure, not a bad frame, so the ceiling must not move.
    const [entry] = await getPending(kv)
    expect(entry.status).toBe('failed')
    expect(entry.attempts ?? 0).toBe(0)
  })

  it('retries the whole step on the next tick, and credits once the write succeeds', async () => {
    const kv = memoryStorage()
    await savePending(kv, TOKEN.frame)
    const order: string[] = []
    let firstCall = true

    await processPending(internalizingWallet(order), kv, 'test', undefined, undefined, async (frame, txid) => {
      if (firstCall) {
        firstCall = false
        throw new Error('database is locked')
      }
      await writeHeldRow(order)(frame, txid)
    })
    const second = await processPending(internalizingWallet(order), kv, 'test', undefined, undefined, async (f, t) => {
      await writeHeldRow(order)(f, t)
    })

    expect(second).toEqual([expect.objectContaining({ success: true })])
    expect(order).toEqual(['held', 'internalize'])
    expect(superPost).not.toHaveBeenCalled()
  })
})
