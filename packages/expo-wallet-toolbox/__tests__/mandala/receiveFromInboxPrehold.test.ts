/**
 * `receiveFromInbox` — the P1-4 ordering fix, exercised end to end.
 *
 * Unlike `createRuntime.test.ts`, `@bsv/mandala` is NOT mocked here: the real
 * `receiveTokens` (`dist/receive.js` `acceptOne`) runs, which is exactly what
 * calls `wallet.internalizeAction` before its own `settle` hook for a v2
 * hand-over message (codebase-review mandala-handle-P1-4). Only
 * `resolveAssetMetadata` — a network+SPV asset-label lookup `acceptOne` calls
 * for cosmetic purposes only, unrelated to the ordering bug — is stubbed, so
 * the test stays hermetic.
 *
 * These use the REAL `StorageExpoSQLite` against real SQLite, with nothing
 * pre-seeded, for the same reason `__tests__/localpay/pendingTokenHold.test.ts`
 * does: a pre-seeded row is exactly the assumption that hid the hole.
 */
jest.mock('@bsv/mandala/metadata', () => ({ resolveAssetMetadata: jest.fn(async () => null) }))
// `StorageExpoSQLite.attemptToPostReqsToNetwork` reads this to decide whether
// a txid with no settlement row gets a real post attempt at all — same mock
// `pendingTokenHold.test.ts` uses, and for the same reason: the real NetInfo
// probe has nothing to answer from in a Node test process.
const mockGetOnline = jest.fn(async () => true)
jest.mock('../../core/net/online', () => ({ getOnline: () => mockGetOnline() }))

import { DatabaseSync } from 'node:sqlite'
import { Beef, PrivateKey, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { configureMandala } from '@bsv/mandala'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'
import { createMandalaRuntime } from '../../core/mandala/createRuntime'
import type { MandalaEndpointConfig } from '../../core/toolboxConfig'
import type { MandalaMessageBox } from '../../core/mandala/createRuntime'

const OVERLAY_PRIV = PrivateKey.fromRandom()
const OVERLAY_KEY = OVERLAY_PRIV.toPublicKey().toString()
const ENDPOINTS: MandalaEndpointConfig = {
  overlayUrl: 'https://overlay.issuer.example',
  overlayIdentityKey: OVERLAY_KEY,
  messageBoxUrl: 'https://box.example'
}
const ASSET_ID = 'ab'.repeat(32) + '.0'
const PAYER = new PrivateKey(7).toPublicKey().toString()
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

function tokenTip(): { tx: Transaction; txid: string; body: Record<string, unknown> } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET_ID, 250, PKH) })
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return {
    tx,
    txid,
    body: {
      v: 2,
      kind: 'handover',
      assetId: ASSET_ID,
      amount: 250,
      sender: PAYER,
      senderMode: 'blinded',
      keyID: 'k',
      protocolID: [2, 'mandala token'],
      transaction: beef.toBinaryAtomic(txid),
      outputIndex: 0,
      linkage: [],
      admissions: []
    }
  }
}

/** Real storage, with only the request/transaction lookups the guard path reads stubbed — same shape as `pendingTokenHold.test.ts`'s `TestStorage`. */
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
let superPost: jest.SpyInstance
let warn: jest.SpyInstance
let log: jest.SpyInstance

const TIP = tokenTip()

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  conn = adapt(raw)
  await createTables(conn as never)
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (7,'n','n','k')`).run()
  storage = new TestStorage(conn, TIP.txid)
  configureMandala({
    overlayUrl: ENDPOINTS.overlayUrl,
    overlayIdentityKey: ENDPOINTS.overlayIdentityKey,
    messageBoxUrl: ENDPOINTS.messageBoxUrl
  })
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

describe('receiveFromInbox: the settlement row lands before the real internalize (P1-4)', () => {
  it('the row already exists at the moment internalizeAction runs, and the guard is never bypassed', async () => {
    const order: string[] = []
    let rowSeenAtInternalize: unknown

    const wallet = {
      internalizeAction: async () => {
        // The exact moment `internalizeAction`'s forced broadcast would run
        // (`shareReqsWithWorld` -> `attemptToPostReqsToNetwork`) for the REAL
        // library — reduced, as `pendingTokenHold.test.ts` does, to the one
        // call that matters.
        rowSeenAtInternalize = await store.getSettlement(TIP.txid)
        order.push('internalize')
        await storage.attemptToPostReqsToNetwork([
          { txid: TIP.txid, provenTxReqId: 1, status: 'unsent', notify: { transactionIds: [1] } } as never
        ])
        return { accepted: true }
      }
    }

    const box: MandalaMessageBox = {
      listMessages: jest.fn(async () => [{ messageId: 'msg-1', body: TIP.body }]),
      acknowledgeMessage: jest.fn(async () => ({})),
      sendMessage: jest.fn(async () => ({}))
    } as unknown as MandalaMessageBox

    const runtime = createMandalaRuntime({
      wallet: wallet as never,
      adminOriginator: 'urn:test:admin',
      storage,
      chain: 'main',
      endpoints: ENDPOINTS,
      messageBox: async () => box
    })
    const { store } = runtime

    expect(await store.getSettlement(TIP.txid)).toBeUndefined()

    const result = await runtime.receiveFromInbox()

    expect(result).toEqual({ credited: 1, failed: 0 })
    expect(order).toEqual(['internalize'])
    // The whole point: by the time the real `internalizeAction` ran, the
    // pre-hold pass had already written the row.
    expect(rowSeenAtInternalize).toMatchObject({ state: 'held', role: 'received', txid: TIP.txid })
    // And the guard genuinely had something to find — no unmediated broadcast
    // slipped through `attemptToPostReqsToNetwork`'s super call.
    expect(superPost).not.toHaveBeenCalled()
    expect((await store.getSettlement(TIP.txid))?.state).toBeDefined()
  })

  it('a message this pass could not decode is left alone: no row, and the library still credits it on its own', async () => {
    const order: string[] = []
    const wallet = {
      internalizeAction: async () => {
        order.push('internalize')
        return { accepted: true }
      }
    }
    // Garbage `transaction` bytes: the pre-hold pass cannot decode it, but
    // `verifyIncoming`/`coverHandover` inside the REAL library run over the
    // identical bytes and refuse it before ever reaching `internalizeAction` —
    // so nothing is credited, and nothing here needed a settlement row.
    const badBody = { ...TIP.body, transaction: [1, 2, 3] }
    const box: MandalaMessageBox = {
      listMessages: jest.fn(async () => [{ messageId: 'bad-1', body: badBody }]),
      acknowledgeMessage: jest.fn(async () => ({})),
      sendMessage: jest.fn(async () => ({}))
    } as unknown as MandalaMessageBox

    const runtime = createMandalaRuntime({
      wallet: wallet as never,
      adminOriginator: 'urn:test:admin',
      storage,
      chain: 'main',
      endpoints: ENDPOINTS,
      messageBox: async () => box
    })

    const result = await runtime.receiveFromInbox()

    expect(result).toEqual({ credited: 0, failed: 1 })
    expect(order).toEqual([])
    expect(await runtime.store.getSettlement(TIP.txid)).toBeUndefined()
    expect(superPost).not.toHaveBeenCalled()
  })
})
