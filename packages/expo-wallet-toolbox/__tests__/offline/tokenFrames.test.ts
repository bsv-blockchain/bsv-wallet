/**
 * FIX I, end to end: a token payment's settlement row outlives the pending
 * queue's retry ceiling.
 *
 * `MAX_PENDING_ATTEMPTS` burns an attempt on ANY `internalizeAction` failure,
 * including a transient `Block header not found for height N` from a
 * fresh-block BUMP this device has not caught up on. A token frame's state of
 * record is `token_settlements`, not `localpay_pending` — so an exhausted queue
 * entry must still contribute its frame to the reconciliation pass, its
 * settlement row must survive, and the row must be abandoned only by an
 * explicit terminal verdict from the overlay.
 */
import { DatabaseSync } from 'node:sqlite'
import { Beef, Transaction, LockingScript } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import {
  isRetriableInternalizeFailure,
  listStuckSettlements,
  reconcileSettlements,
  type EvidenceFrame
} from '../../core/mandala/drain'
import {
  frameTxid,
  tokenFrameSourcesFromOfflineActions,
  tokenFrameSourcesFromPending
} from '../../core/offline/tokenFrames'
import { isPendingExhausted, MAX_PENDING_ATTEMPTS } from '../../core/localpay/pending'
import type { OfflineActionRow } from '../../core/storage/methods/offlineActions'
import { STUCK_AFTER_MS, type SettlementStore } from '../../core/mandala/types'

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

const ASSET_ID = 'ab'.repeat(32) + '.0'
const OVERLAY = 'https://overlay.issuer.example'
const OVERLAY_KEY = '02' + 'cd'.repeat(32)

function tokenBeef(): { bytes: Uint8Array; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET_ID, 100, new Array(20).fill(1)) })
  tx.addOutput({ satoshis: 500, lockingScript: LockingScript.fromHex('51') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { bytes: new Uint8Array(beef.toBinaryAtomic(tx.id('hex'))), txid: tx.id('hex') }
}

const { bytes, txid } = tokenBeef()

const frame = (): EvidenceFrame => ({
  kind: 'token',
  transaction: bytes,
  token: { assetId: ASSET_ID, overlayUrl: OVERLAY, overlayIdentityKey: OVERLAY_KEY, linkage: [], admissions: [] }
})

const bsvFrame = (): EvidenceFrame => ({ kind: 'bsv', transaction: bytes })

let raw: DatabaseSync
let store: SettlementStore

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  store = createSettlementStore(adapt(raw) as unknown as SettlementDb)
})

afterEach(() => raw.close())

describe('frameTxid', () => {
  it('reads the atomic subject txid — the key a settlement row uses', () => {
    expect(frameTxid(frame())).toBe(txid)
  })

  it('returns undefined rather than throwing for unreadable bytes', () => {
    expect(frameTxid({ transaction: new Uint8Array([1, 2]) })).toBeUndefined()
  })
})

describe('tokenFrameSourcesFromPending', () => {
  it('includes an entry the pending queue has already given up on (FIX I)', () => {
    const exhausted = { frame: frame(), status: 'failed', attempts: MAX_PENDING_ATTEMPTS, id: 'x', receivedAt: 'n' }
    // Pin the premise: the pending queue really would abandon this one.
    expect(isPendingExhausted(exhausted as never)).toBe(true)

    // `amountBaseUnits` is read off the tip's own script, so a row re-derived
    // here carries the figure the activity list prints (2026-09-16).
    expect(tokenFrameSourcesFromPending([exhausted])).toEqual([
      { txid, role: 'received', frame: exhausted.frame, amountBaseUnits: 100 }
    ])
  })

  it('skips a plain BSV frame and an unreadable one', () => {
    expect(
      tokenFrameSourcesFromPending([{ frame: bsvFrame() }, { frame: { ...frame(), transaction: new Uint8Array([0]) } }])
    ).toEqual([])
  })
})

describe('tokenFrameSourcesFromOfflineActions', () => {
  const row = (over: Partial<OfflineActionRow> = {}): OfflineActionRow => ({
    offlineActionId: 1,
    created_at: 'n',
    updated_at: 'n',
    userId: 1,
    txid,
    seq: 1,
    role: 'sent',
    senderIdentityKey: null,
    receivedVia: null,
    status: 'queued',
    rejectedReason: null,
    poisonedByTxid: null,
    framePayload: 'bsvpayf1:sealed',
    ...over
  })

  it('opens what the caller can decrypt and keeps the row’s own role', () => {
    expect(tokenFrameSourcesFromOfflineActions([row()], () => frame())).toEqual([
      { txid, role: 'sent', frame: frame(), state: undefined, amountBaseUnits: 100 }
    ])
  })

  // The sealed QR needs the session pre-shared key, which the drain does not
  // hold. A row nobody can open must not take down the pass.
  it('skips a row the caller cannot open, and one with no payload at all', () => {
    const decode = () => {
      throw new Error('no pre-shared key for this session')
    }
    expect(tokenFrameSourcesFromOfflineActions([row(), row({ framePayload: null })], decode)).toEqual([])
  })

  // A parked payment is the user's, never the drain's: reconciliation must not
  // promote it into a state the drain will submit.
  it('keeps a parked row parked', () => {
    expect(tokenFrameSourcesFromOfflineActions([row({ status: 'parked' })], () => frame())[0].state).toBe('parked')
  })
})

describe('a settlement row outliving the retry ceiling', () => {
  const exhausted = { frame: frame(), status: 'failed', attempts: MAX_PENDING_ATTEMPTS + 5 }

  it('is re-derived from an exhausted pending entry and then kept alive by every later pass', async () => {
    const first = await reconcileSettlements({ store, sources: tokenFrameSourcesFromPending([exhausted]) })
    expect(first.derived).toBe(1)

    // Whatever the queue thinks, the drain's own row is here and non-terminal.
    expect((await store.getSettlement(txid))?.state).toBe('held')

    await reconcileSettlements({ store, sources: tokenFrameSourcesFromPending([exhausted]) })
    expect((await store.getSettlement(txid))?.state).toBe('held')
  })

  it('is abandoned only by an explicit terminal verdict, never by a count', async () => {
    await reconcileSettlements({ store, sources: tokenFrameSourcesFromPending([exhausted]) })
    await store.advanceSettlement(txid, ['held'], 'refused', { refusedCode: 'ERR_CONSERVATION' })

    // A later reconciliation must NOT resurrect a row the overlay killed.
    await reconcileSettlements({ store, sources: tokenFrameSourcesFromPending([exhausted]) })
    expect((await store.getSettlement(txid))?.state).toBe('refused')
  })

  it('surfaces as stuck rather than silently retrying forever', async () => {
    await store.upsertSettlement({
      txid,
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: OVERLAY,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: new Date(Date.now() - STUCK_AFTER_MS - 1).toISOString()
    })
    expect((await listStuckSettlements(store)).map(r => r.txid)).toEqual([txid])
  })

  it('classifies the header lag that would otherwise have burned the ceiling', () => {
    expect(isRetriableInternalizeFailure('Block header not found for height 899123')).toBe(true)
  })
})
