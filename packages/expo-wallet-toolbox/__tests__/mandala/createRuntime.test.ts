/**
 * `createMandalaRuntime` — the seam between the wallet and `@bsv/mandala`.
 *
 * What is pinned here is exactly what the rest of the wallet is not allowed to
 * get wrong:
 *
 *  · **Availability is a gate, not a preference.** A runtime on a chain the
 *    host stated no endpoints for must refuse to send rather than address
 *    nothing.
 *  · **FIX D, in both directions.** An overlay refusal that can lift
 *    (`ERR_PAUSED`) must come back as `unavailable`/retryable and leave every
 *    row where it was; a final one (`ERR_CONSERVATION`) must come back as
 *    `refused` and burn it. Confusing the two either strands money that would
 *    have settled or broadcasts money the issuer rejected.
 *  · **FIX H.** A received transfer is `admitted` only when a σ_I verified
 *    against THIS overlay's key. Anything else is `held` — never a decline.
 *  · **COVER runs through the real lib**, over evidence assembled from the
 *    real settlement tables, so the wallet and the overlay cannot come to
 *    disagree about what a signature covers.
 *
 * The lib's `transferTokens`/`receiveTokens` are mocked (they are whole
 * pipelines with their own suites in the lib); everything else — the COVER
 * walk, the admission digest, the facilitator, the refusal taxonomy — is the
 * real thing.
 */
jest.mock('@bsv/mandala', () => {
  const actual = jest.requireActual('@bsv/mandala')
  return {
    ...actual,
    transferTokens: jest.fn(),
    receiveTokens: jest.fn(),
    fetchAdmission: jest.fn(),
    fetchRegistry: jest.fn(),
    reconcileWallet: jest.fn(),
    reconcileNotifications: jest.fn()
  }
})
jest.mock('@bsv/mandala/adminState', () => ({ resolveAssetState: jest.fn() }))

import { DatabaseSync } from 'node:sqlite'
import {
  Beef,
  Hash,
  LockingScript,
  PrivateKey,
  Transaction,
  UnlockingScript,
  Utils,
  type ListOutputsArgs
} from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import {
  admissionMessageV2,
  blindingGet,
  blindingListReserved,
  configureMandala,
  fetchAdmission as libFetchAdmission,
  fetchRegistry,
  payloadHash,
  receiveTokens,
  reconcileNotifications,
  reconcileWallet,
  transferTokens,
  type OverlayRegistryRow
} from '@bsv/mandala'
import { resolveAssetState } from '@bsv/mandala/adminState'
import { createTables } from '../../core/storage/schema/createTables'
import {
  activityStatusOf,
  bindOriginator,
  createMandalaKvStorage,
  createMandalaRuntime,
  verdictFromError
} from '../../core/mandala/createRuntime'
import type { CoverBundle } from '../../core/mandala/bundle'
import { postTokenStep } from '../../core/mandala/drain'
import { STUCK_AFTER_MS, type SettlementStore, type TokenSettlementRow } from '../../core/mandala/types'
import type { MandalaRuntime } from '../../core/mandala/runtime'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import type { MandalaEndpointConfig } from '../../core/toolboxConfig'

// ─────────────────────────────── fixtures ───────────────────────────────

const OVERLAY_PRIV = PrivateKey.fromRandom()
const OVERLAY_KEY = OVERLAY_PRIV.toPublicKey().toString()
const ENDPOINTS: MandalaEndpointConfig = {
  overlayUrl: 'https://overlay.issuer.example',
  overlayIdentityKey: OVERLAY_KEY,
  messageBoxUrl: 'https://box.example'
}
const ASSET_ID = 'ab'.repeat(32) + '.0'
const OTHER_ASSET = 'cd'.repeat(32) + '.1'
const PAYER = new PrivateKey(7).toPublicKey().toString()
const PAYEE = new PrivateKey(9).toPublicKey().toString()

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

const pkh = () => Hash.hash160(Utils.toArray(PrivateKey.fromRandom().toPublicKey().toString(), 'hex'))
const tokenScript = (amount: number, assetId = ASSET_ID) => new MandalaToken().lock(assetId, amount, pkh())

function rootTx(amount = 100, assetId = ASSET_ID): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: tokenScript(amount, assetId) })
  return tx
}

function txSpending(parents: { tx: Transaction; vout: number }[], amount = 60, assetId = ASSET_ID): Transaction {
  const tx = new Transaction()
  for (const p of parents) {
    tx.addInput({ sourceTransaction: p.tx, sourceOutputIndex: p.vout, unlockingScript: UnlockingScript.fromHex('') })
  }
  tx.addOutput({ satoshis: 1, lockingScript: tokenScript(amount, assetId) })
  tx.addOutput({ satoshis: 500, lockingScript: LockingScript.fromHex('51') })
  return tx
}

/** A real σ_I: the same bytes the overlay signs, by the overlay's own key. */
function signAdmission(txid: string, outputsToAdmit: number[]): string {
  return OVERLAY_PRIV.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8')).toDER('hex') as string
}

interface FakeReq {
  txid: string
  rawTx: number[]
  inputBEEF?: number[]
  status?: string
}

/** The slice of `StorageExpoSQLite` the runtime touches. */
function fakeStorage(db: ReturnType<typeof adapt>, reqs: FakeReq[] = [], ancestry: Transaction[] = []) {
  return {
    sqliteDb: db,
    getKeyValue: async () => undefined,
    setKeyValue: async () => undefined,
    findProvenTxReqs: async ({ partial }: { partial: { txid?: string } }) =>
      reqs.filter(r => partial.txid === undefined || r.txid === partial.txid),
    // The toolbox's own ancestry lookup: the bytes of a parent this wallet
    // holds anywhere (proven, unproven change, …), merged into the caller's beef.
    getValidBeefForTxid: async (txid: string, mergeToBeef?: Beef) => {
      const tx = ancestry.find(t => t.id('hex') === txid)
      if (!tx) return undefined
      const beef = mergeToBeef ?? new Beef()
      beef.mergeTransaction(tx)
      return beef
    }
  } as unknown as StorageExpoSQLite
}

/** A wallet that answers the two calls the runtime makes of it. */
function fakeWallet(outputs: { tx: Transaction; vout: number }[] = []) {
  const beef = new Beef()
  for (const o of outputs) beef.mergeTransaction(o.tx)
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: PAYER })),
    // Typed to the real `ListOutputsArgs` (rather than left as a 0-arg fake) so
    // that a test overriding this mock's implementation to read `offset`/`limit`
    // — as the pagination test below does — is checked against the shape the
    // runtime actually calls it with.
    listOutputs: jest.fn(async (_args: ListOutputsArgs) => ({
      totalOutputs: outputs.length,
      outputs: outputs.map(o => ({
        outpoint: `${o.tx.id('hex')}.${o.vout}`,
        satoshis: 1,
        spendable: true,
        lockingScript: undefined,
        customInstructions: undefined
      })),
      BEEF: outputs.length > 0 ? beef.toBinary() : undefined
    }))
  }
}

/**
 * A fake wallet that can also drive the real `prepareBlindedPayment` — the
 * fast in-process-ECDH path (`keyDeriver.revealCounterpartySecret`), plus a
 * passthrough `encrypt` for the two linkage-revelation ciphertexts. Only
 * `lockToPayee` exercises this; every other test uses the plain `fakeWallet`.
 */
function blindingWallet(outputs: { tx: Transaction; vout: number }[] = []) {
  const sharedSecret = PrivateKey.fromRandom().toPublicKey()
  return {
    ...fakeWallet(outputs),
    encrypt: jest.fn(async ({ plaintext }: { plaintext: number[] }) => ({ ciphertext: plaintext })),
    keyDeriver: { revealCounterpartySecret: () => sharedSecret.encode(true) as number[] }
  }
}

const messageBox = () => ({
  sendMessage: jest.fn(async () => ({})),
  listMessages: jest.fn(async () => []),
  acknowledgeMessage: jest.fn(async () => ({}))
})

let raw: DatabaseSync
let db: ReturnType<typeof adapt>

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = adapt(raw)
  await createTables(db as never)
  configureMandala({
    overlayUrl: ENDPOINTS.overlayUrl,
    overlayIdentityKey: ENDPOINTS.overlayIdentityKey,
    messageBoxUrl: ENDPOINTS.messageBoxUrl
  })
  ;(transferTokens as jest.Mock).mockReset()
  ;(receiveTokens as jest.Mock).mockReset()
  ;(libFetchAdmission as jest.Mock).mockReset()
  ;(fetchRegistry as jest.Mock).mockReset().mockResolvedValue([])
  ;(resolveAssetState as jest.Mock).mockReset().mockResolvedValue(null)
  ;(reconcileWallet as jest.Mock)
    .mockReset()
    .mockResolvedValue({ rebroadcast: [], aborted: [], resubmitted: [], stranded: [], swept: 0 })
  ;(reconcileNotifications as jest.Mock).mockReset().mockResolvedValue([])
})

afterEach(() => raw.close())

function build(
  overrides: Partial<Parameters<typeof createMandalaRuntime>[0]> = {},
  outputs: { tx: Transaction; vout: number }[] = [],
  reqs: FakeReq[] = []
): MandalaRuntime {
  return createMandalaRuntime({
    wallet: fakeWallet(outputs) as never,
    adminOriginator: 'urn:test:admin',
    storage: fakeStorage(db, reqs),
    chain: 'main',
    endpoints: ENDPOINTS,
    messageBox: async () => messageBox() as never,
    resolveMetadata: async () => ({ label: 'Acme Dollar', ticker: 'USDX', decimals: 2 }),
    ...overrides
  })
}

// ─────────────────── the journal store, and the originator ───────────────────

describe('the journal storage adapter (D3c)', () => {
  it('reads, writes, removes and prefix-scans through the wallet’s own key/value table', async () => {
    const kv = new Map<string, string>()
    const storage = {
      sqliteDb: db,
      getKeyValue: async (k: string) => kv.get(k),
      setKeyValue: async (k: string, v: string) => {
        kv.set(k, v)
        await db.runAsync(
          `INSERT INTO key_value_store (key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [k, v, new Date().toISOString()]
        )
      }
    }
    const adapter = createMandalaKvStorage(storage as never)

    expect(await adapter.getItem('mandala.tx.a')).toBeNull()
    await adapter.setItem('mandala.tx.a', '{"stage":"accepted"}')
    await adapter.setItem('mandala.tx.b', '{}')
    await adapter.setItem('other', '{}')
    expect(await adapter.getItem('mandala.tx.a')).toBe('{"stage":"accepted"}')
    expect((await adapter.keys('mandala.tx.')).sort()).toEqual(['mandala.tx.a', 'mandala.tx.b'])

    await adapter.removeItem('mandala.tx.a')
    expect(await adapter.keys('mandala.tx.')).toEqual(['mandala.tx.b'])
  })

  it('treats a prefix’s LIKE wildcards literally, so one journal cannot scan another', async () => {
    const storage = {
      sqliteDb: db,
      getKeyValue: async () => undefined,
      setKeyValue: async (k: string, v: string) => {
        await db.runAsync('INSERT INTO key_value_store (key, value, updated_at) VALUES (?,?,?)', [k, v, 'now'])
      }
    }
    const adapter = createMandalaKvStorage(storage as never)
    await adapter.setItem('a_b.1', '{}')
    await adapter.setItem('axb.1', '{}')
    expect(await adapter.keys('a_b.')).toEqual(['a_b.1'])
  })

  it('fails loudly when the database is closed — a silent removeItem would strand a journal entry', async () => {
    const adapter = createMandalaKvStorage({
      getKeyValue: async () => undefined,
      setKeyValue: async () => undefined
    } as never)
    await expect(adapter.removeItem('x')).rejects.toThrow(/database is not open/)
    await expect(adapter.keys('x')).rejects.toThrow(/database is not open/)
  })
})

describe('bindOriginator', () => {
  it('runs every lib call as the admin originator, and passes an explicit one through', async () => {
    const wallet = {
      listOutputs: jest.fn(async (_args: ListOutputsArgs) => ({ outputs: [] })),
      keyDeriver: { marker: 1 }
    }
    const bound = bindOriginator(wallet, 'urn:test:admin') as typeof wallet
    await bound.listOutputs({ basket: 'p mandala' })
    expect(wallet.listOutputs).toHaveBeenCalledWith({ basket: 'p mandala' }, 'urn:test:admin')
    // Non-function properties are passed straight through: the lib reads
    // `wallet.keyDeriver` to take the in-process ECDH shortcut.
    expect(bound.keyDeriver).toEqual({ marker: 1 })
  })
})

// ───────────────────────────── availability ─────────────────────────────

describe('availability', () => {
  it('is available on main with endpoints', () => {
    expect(build().available).toBe(true)
  })

  it('is available on whichever chain the host stated endpoints for, and on no chain without them', () => {
    expect(build({ chain: 'test' }).available).toBe(true)
    expect(build({ chain: 'teratest' }).available).toBe(true)
    expect(build({ chain: 'test', endpoints: undefined }).available).toBe(false)
    expect(build({ chain: 'main', endpoints: undefined }).available).toBe(false)
  })

  it('publishes the CONFIGURED deployment as the one trust anchor a call site may state', () => {
    // `verifyFramePayment`'s `opts.asset` and a session's own asset block are
    // both meant to be THIS device's configuration. Anything a frame carries is
    // the payer's claim.
    expect(build().endpoints).toEqual(ENDPOINTS)
    // Empty on a chain with no deployment — a value no frame can equal.
    expect(build({ endpoints: undefined }).endpoints).toEqual({
      overlayUrl: '',
      overlayIdentityKey: '',
      messageBoxUrl: ''
    })
  })

  it('is unavailable with no endpoints, and refuses to send rather than addressing nothing', async () => {
    const runtime = build({ endpoints: undefined })
    expect(runtime.available).toBe(false)
    await expect(
      runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 5 })
    ).resolves.toMatchObject({ kind: 'unavailable' })
    expect(transferTokens).not.toHaveBeenCalled()
  })
})

// ──────────────────────── balances / assets / activity ────────────────────────

describe('balances, assets and activity', () => {
  it('values coins from their SCRIPT, groups by asset, and names them from the registry', async () => {
    const a = rootTx(100)
    const b = rootTx(25)
    const other = rootTx(7, OTHER_ASSET)
    const runtime = build({}, [
      { tx: a, vout: 0 },
      { tx: b, vout: 0 },
      { tx: other, vout: 0 }
    ])

    const balances = await runtime.balances()
    const mine = balances.find(x => x.asset.assetId === ASSET_ID)
    // 1 satoshi each on chain; 125 base units in the scripts.
    expect(mine?.baseUnits).toBe(125)
    expect(mine?.asset.label).toBe('Acme Dollar')
    expect(mine?.asset.ticker).toBe('USDX')
    expect(mine?.asset.decimals).toBe(2)
    expect(mine?.asset.overlayIdentityKey).toBe(OVERLAY_KEY)
    expect(balances.find(x => x.asset.assetId === OTHER_ASSET)?.baseUnits).toBe(7)

    expect((await runtime.listAssets()).map(x => x.assetId).sort()).toEqual([ASSET_ID, OTHER_ASSET].sort())
  })

  it('reads the WHOLE basket, page by page, so the balance never under-counts what the build can spend', async () => {
    // Five coins served two to a page, with the wallet's own total as the
    // authority: a short page must not end the walk, and each page's BEEF must
    // be merged before its coins are valued — the exact discipline the payment
    // build's `listTokenBasket` already follows, and the one the balance reader
    // lacked (one unpaged read of 1000 → "more than your USDX balance" for
    // money the wallet held).
    const coins = [10, 20, 30, 40, 50].map(amount => ({ tx: rootTx(amount), vout: 0 }))
    const wallet = fakeWallet(coins)
    wallet.listOutputs.mockImplementation(async (args: { offset?: number; limit?: number }) => {
      const page = coins.slice(args.offset ?? 0, (args.offset ?? 0) + 2)
      const beef = new Beef()
      for (const c of page) beef.mergeTransaction(c.tx)
      return {
        totalOutputs: coins.length,
        outputs: page.map(c => ({
          outpoint: `${c.tx.id('hex')}.${c.vout}`,
          satoshis: 1,
          spendable: true,
          lockingScript: undefined,
          customInstructions: undefined
        })),
        BEEF: page.length ? beef.toBinary() : undefined
      }
    })
    const runtime = build({ wallet: wallet as never })

    const mine = (await runtime.balances()).find(x => x.asset.assetId === ASSET_ID)
    expect(mine?.baseUnits).toBe(150)
    // Three pages: offsets 0, 2, 4 — and no fourth, because the total says so.
    expect(wallet.listOutputs.mock.calls.map(c => (c[0] as { offset?: number }).offset)).toEqual([0, 2, 4])
  })

  it('counts received-but-unsettled rows separately from spendable balance', async () => {
    const runtime = build({}, [{ tx: rootTx(100), vout: 0 }])
    const store = runtime.store
    await store.upsertSettlement({
      txid: 'aa'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      amountBaseUnits: 40,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    await store.upsertSettlement({
      txid: 'bb'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'broadcast',
      amountBaseUnits: 11,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })

    const mine = (await runtime.balances()).find(x => x.asset.assetId === ASSET_ID)
    expect(mine?.unsettledBaseUnits).toBe(40)
  })

  it('a refused row is not "unsettled" money — it is gone', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: 'cc'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'refused',
      amountBaseUnits: 500,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    const mine = (await runtime.balances()).find(x => x.asset.assetId === ASSET_ID)
    expect(mine?.unsettledBaseUnits).toBe(0)
  })

  it('reports activity newest-first with a status per row', async () => {
    const runtime = build()
    for (const [txid, state, role] of [
      ['11'.repeat(32), 'held', 'received'],
      ['22'.repeat(32), 'broadcast', 'sent'],
      ['33'.repeat(32), 'refused', 'sent']
    ] as const) {
      await runtime.store.upsertSettlement({
        txid,
        role,
        assetId: ASSET_ID,
        state,
        amountBaseUnits: 3,
        counterpartyKey: PAYEE,
        overlayUrl: ENDPOINTS.overlayUrl,
        overlayIdentityKey: OVERLAY_KEY,
        ...(state === 'refused' ? { refusedCode: 'ERR_CONSERVATION' } : {})
      })
    }
    const rows = await runtime.activity()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(r => r.status))).toEqual(new Set(['settling', 'settled', 'refused']))
    expect(rows.every(r => r.asset.label === 'Acme Dollar')).toBe(true)
  })

  it('an admitted row reads as settled, and a long-waiting non-terminal one as stuck', () => {
    const base: TokenSettlementRow = {
      txid: 'dd'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'admitted',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString()
    }
    const now = 1_000 + STUCK_AFTER_MS + 1
    expect(activityStatusOf(base, now)).toBe('settled')
    expect(activityStatusOf({ ...base, state: 'held' }, now)).toBe('stuck')
    expect(activityStatusOf({ ...base, state: 'held' }, 2_000)).toBe('settling')
    expect(activityStatusOf({ ...base, state: 'orphaned' }, now)).toBe('reversed')
  })

  it('surfaces rows that have been waiting past the bound', async () => {
    const runtime = build()
    const old = new Date(Date.now() - STUCK_AFTER_MS - 60_000).toISOString()
    await runtime.store.upsertSettlement({
      txid: 'ee'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: old
    })
    await runtime.store.upsertSettlement({
      txid: 'ff'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    const stuck = await runtime.stuck()
    expect(stuck.map(r => r.txid)).toEqual(['ee'.repeat(32)])
  })
})

// ────────────────────────────── sendToHandle ──────────────────────────────

describe('sendToHandle', () => {
  it('hands the payment over — never submits — and journals the row handed_over', async () => {
    const txid = '99'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true })
    const runtime = build()
    const seen: number[] = []
    runtime.subscribe(() => seen.push(1))

    const result = await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 12 })
    // Never `settled`: no σ_I was asked for, so none is in hand.
    expect(result).toEqual({ kind: 'sent', txid, settled: false, notified: true })

    // The whole of the 2026-09-15 decision, in one assertion.
    expect((transferTokens as jest.Mock).mock.calls[0][0]).toMatchObject({
      mode: 'handover',
      assetId: ASSET_ID,
      amount: 12,
      recipientKey: PAYEE
    })

    const row = await runtime.store.getSettlement(txid)
    expect(row?.role).toBe('sent')
    expect(row?.state).toBe('handed_over')
    expect(row?.amountBaseUnits).toBe(12)
    expect(row?.counterpartyKey).toBe(PAYEE)
    expect(await runtime.store.getAdmission(txid)).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('forwards the payer’s note to transferTokens, when one is given', async () => {
    const txid = '98'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true })
    const runtime = build()
    await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 12, note: 'lunch split' })
    expect((transferTokens as jest.Mock).mock.calls[0][0]).toMatchObject({ note: 'lunch split' })
  })

  it('sends no note field at all when the payer gives none', async () => {
    const txid = '97'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true })
    const runtime = build()
    await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 12 })
    expect((transferTokens as jest.Mock).mock.calls[0][0].note).toBeUndefined()
  })

  /**
   * The abort guard's other half: the reference has to be ON the row.
   *
   * The action that built these bytes is `noSend` and stays that way until the
   * drain broadcasts it, so until then the only thing holding this device's
   * inputs is that action — and `abortAction(reference)` frees them. The row is
   * what `wrapAbortActionForSettlements` matches an abort against, and it has
   * to be written before the send's own submit, because the window opens the
   * instant the overlay admits (and broadcasts).
   */
  it('records the noSend action’s reference on the row, so an abort of it can be refused', async () => {
    const txid = '95'.repeat(32)
    const reference = 'the-noSend-action-reference'
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true, reference })
    const runtime = build()

    await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 12 })

    expect((await runtime.store.getSettlement(txid))?.reference).toBe(reference)
    expect(await runtime.store.getSettlementByReference(reference)).toMatchObject({ txid, state: 'handed_over' })
  })

  it('journals the payment anyway when the lib reports no reference — an unknown one blocks nothing', async () => {
    const txid = '94'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true })
    const runtime = build()

    await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 12 })

    const row = await runtime.store.getSettlement(txid)
    expect(row?.state).toBe('handed_over')
    expect(row?.reference).toBeUndefined()
  })

  it('contacts NOTHING: no facilitator, no fetch, on the whole send path', async () => {
    const txid = '97'.repeat(32)
    const fetchImpl = jest.fn(async () => {
      throw new Error('the send path must never reach the network')
    })
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, handedOver: true })
    const runtime = build({ fetchImpl: fetchImpl as never })

    expect((await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 4 })).kind).toBe(
      'sent'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    // And the lib is never handed a facilitator it could submit through.
    expect((transferTokens as jest.Mock).mock.calls[0][0].facilitator).toBeUndefined()
  })

  it('hands the lib an evidence source that answers from the settlement tables', async () => {
    const ancestor = 'aa'.repeat(32)
    const unadmitted = 'bb'.repeat(32)
    const foreign = 'cc'.repeat(32)
    const signature = signAdmission(ancestor, [0])
    const runtime = build()
    await runtime.store.putAdmission({
      txid: ancestor,
      outputsToAdmit: [0],
      signatureHex: signature,
      signerKey: OVERLAY_KEY,
      source: 'submitted',
      obtainedAt: new Date().toISOString()
    })
    await runtime.store.putLinkage({
      txid: unadmitted,
      payloadBytes: Uint8Array.from([7, 8, 9]),
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      source: 'forwarded',
      createdAt: new Date().toISOString()
    })
    // A σ_I this overlay did not sign is ABSENT, never forwarded as this
    // device's own claim about the chain (FIX H / §9.10).
    await runtime.store.putAdmission({
      txid: foreign,
      outputsToAdmit: [0],
      signatureHex: 'dead',
      signerKey: new PrivateKey(11).toPublicKey().toString(),
      source: 'bundle',
      obtainedAt: new Date().toISOString()
    })

    ;(transferTokens as jest.Mock).mockResolvedValue({ txid: '96'.repeat(32), notified: true, handedOver: true })
    await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 1 })
    const evidence = (transferTokens as jest.Mock).mock.calls[0][0].evidence

    expect(await evidence.admissionFor(ancestor)).toEqual({
      outputsToAdmit: [0],
      signature,
      signerKey: OVERLAY_KEY
    })
    expect(await evidence.admissionFor(foreign)).toBeUndefined()
    expect(await evidence.admissionFor(unadmitted)).toBeUndefined()
    expect(await evidence.linkageFor(unadmitted)).toEqual([7, 8, 9])
    expect(await evidence.linkageFor(ancestor)).toBeUndefined()
  })

  it('leaves the row non-terminal, for the drain to finish on the next online tick', async () => {
    const txid = '88'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true })
    const runtime = build()
    expect(await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 3 })).toEqual({
      kind: 'sent',
      txid,
      settled: false,
      notified: true
    })
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
    expect(await runtime.store.getAdmission(txid)).toBeUndefined()
  })

  it('a FINAL overlay refusal is refused, with the overlay’s own code', async () => {
    ;(transferTokens as jest.Mock).mockRejectedValue(
      Object.assign(new Error('overlay refused (ERR_CONSERVATION)'), {
        name: 'OverlayRefusedError',
        code: 'ERR_CONSERVATION',
        retryable: false,
        httpStatus: 400
      })
    )
    const result = await build().sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 3 })
    expect(result).toMatchObject({ kind: 'refused', code: 'ERR_CONSERVATION' })
  })

  it('a LIFTABLE refusal is unavailable, never refused — the condition can lift (FIX D)', async () => {
    ;(transferTokens as jest.Mock).mockRejectedValue(
      Object.assign(new Error('overlay refused (ERR_PAUSED)'), {
        name: 'OverlayRefusedError',
        code: 'ERR_PAUSED',
        retryable: true,
        httpStatus: 409
      })
    )
    const result = await build().sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 3 })
    expect(result.kind).toBe('unavailable')
  })

  it('an ordinary transport failure is unavailable, and writes no row', async () => {
    ;(transferTokens as jest.Mock).mockRejectedValue(new Error('Network request failed'))
    const runtime = build()
    expect((await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 3 })).kind).toBe(
      'unavailable'
    )
    expect(await runtime.store.listSettlements()).toHaveLength(0)
  })

  it('refuses an address before any wallet or overlay work (D4)', async () => {
    const runtime = build()
    const result = await runtime.sendToHandle({
      assetId: ASSET_ID,
      recipientIdentityKey: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      baseUnits: 3
    })
    expect(result).toMatchObject({ kind: 'refused', code: 'ERR_RECIPIENT' })
    expect(transferTokens).not.toHaveBeenCalled()
    expect(runtime.recipientRefusal('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toMatch(/identity key/i)
    expect(runtime.recipientRefusal(PAYEE)).toBeNull()
  })
})

// ──────────────────────────── receiveFromInbox ────────────────────────────

describe('receiveFromInbox', () => {
  function credited(tx: Transaction, admission?: { signature: string; outputsToAdmit: number[] }) {
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const txid = tx.id('hex')
    return {
      id: 'msg-1',
      assetId: ASSET_ID,
      amount: '60',
      sender: PAYER,
      keyID: 'k',
      protocolID: [2, 'mandala token'] as [2, string],
      transaction: beef.toBinaryAtomic(txid),
      outputIndex: 0,
      label: 'Acme Dollar',
      decimals: 2,
      admissionVerified: admission !== undefined,
      ...(admission
        ? { admission: { txid, outputsToAdmit: admission.outputsToAdmit, signature: admission.signature, signerKey: OVERLAY_KEY } }
        : {})
    }
  }

  it('a verified σ_I opens the row admitted, and caches the admission', async () => {
    const parent = rootTx(100)
    const tx = txSpending([{ tx: parent, vout: 0 }])
    const txid = tx.id('hex')
    const signature = signAdmission(txid, [0])
    ;(receiveTokens as jest.Mock).mockResolvedValue({
      accepted: [credited(tx, { signature, outputsToAdmit: [0] })],
      failed: []
    })

    const runtime = build()
    expect(await runtime.receiveFromInbox()).toEqual({ credited: 1, failed: 0 })
    const row = await runtime.store.getSettlement(txid)
    expect(row?.state).toBe('admitted')
    expect(row?.role).toBe('received')
    expect(row?.amountBaseUnits).toBe(60)
    expect(row?.counterpartyKey).toBe(PAYER)
    expect((await runtime.store.getAdmission(txid))?.signatureHex).toBe(signature)
    // The edge graph is derived from the frame's own bytes, not from the body.
    expect(await runtime.store.parentsOf(txid)).toEqual([
      { childTxid: txid, parentTxid: parent.id('hex'), parentVout: 0 }
    ])
  })

  it('an unverified transfer is HELD — never declined — and caches no admission (FIX H)', async () => {
    const tx = txSpending([{ tx: rootTx(100), vout: 0 }])
    const txid = tx.id('hex')
    ;(receiveTokens as jest.Mock).mockResolvedValue({ accepted: [credited(tx)], failed: [{ messageId: 'x', error: 1 }] })

    const runtime = build()
    expect(await runtime.receiveFromInbox()).toEqual({ credited: 1, failed: 1 })
    expect((await runtime.store.getSettlement(txid))?.state).toBe('held')
    expect(await runtime.store.getAdmission(txid)).toBeUndefined()
  })

  it('credits nothing when the runtime is not available on this chain', async () => {
    expect(await build({ chain: 'test', endpoints: undefined }).receiveFromInbox()).toEqual({ credited: 0, failed: 0 })
    expect(receiveTokens).not.toHaveBeenCalled()
  })
})

// ───────────────────────────── cover and submit ─────────────────────────────

describe('cover, through the real lib, over the real tables', () => {
  it('covers a 1-hop bundle whose parent this device holds σ_I for, and names the tip to submit', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const parentTxid = parent.id('hex')
    const tipTxid = tip.id('hex')
    const inputBeef = new Beef()
    inputBeef.mergeTransaction(parent)

    const runtime = build({}, [], [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBeef.toBinary() }])
    await runtime.store.putAdmission({
      txid: parentTxid,
      outputsToAdmit: [0],
      signatureHex: signAdmission(parentTxid, [0]),
      signerKey: OVERLAY_KEY,
      source: 'bundle',
      obtainedAt: new Date().toISOString()
    })

    expect(await runtime.cover(tipTxid)).toEqual({ ok: true, mustSubmit: [tipTxid] })
  })

  it('an unadmitted ancestor whose BYTES are present is not a hole — it joins mustSubmit, parents first', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const tipTxid = tip.id('hex')
    const inputBeef = new Beef()
    inputBeef.mergeTransaction(parent)

    const runtime = build({}, [], [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBeef.toBinary() }])
    // This is §1.6's "whoever reconnects first settles the whole chain": the
    // parent has no σ_I, but its bytes are here, so it is submittable rather
    // than a coverage hole.
    expect(await runtime.cover(tipTxid)).toEqual({ ok: true, mustSubmit: [parent.id('hex'), tipTxid] })
  })

  it('an ancestor with neither σ_I nor bytes IS a hole — and a hole is never a local refusal', async () => {
    const tip = txSpending([{ tx: rootTx(100), vout: 0 }])
    const tipTxid = tip.id('hex')
    // Only the tip's own raw bytes: the parent is a txid the walk cannot enter.
    const runtime = build({}, [], [{ txid: tipTxid, rawTx: tip.toBinary() }])
    expect(await runtime.cover(tipTxid)).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })

  it('bytes this device does not hold are a shape failure, never a verdict', async () => {
    expect(await build().cover('ab'.repeat(32))).toEqual({ ok: false, reason: 'shape' })
  })
})

// ───────── coverVerifier: the incoming-frame walk trusts only OUR key (§9.10) ─────────

describe('coverVerifier — the incoming-frame COVER walk, amendment §9.10', () => {
  const attackerKey = new PrivateKey(999).toPublicKey().toString()

  function bundleFor(parent: Transaction, claimedOverlayIdentityKey: string, signerKey: string): CoverBundle {
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const parentTxid = parent.id('hex')
    return {
      assetId: ASSET_ID,
      overlayIdentityKey: claimedOverlayIdentityKey,
      beef: new Map([
        [parentTxid, parent],
        [tip.id('hex'), tip]
      ]),
      linkage: new Map(),
      admissions: new Map([
        [
          parentTxid,
          {
            txid: parentTxid,
            outputsToAdmit: [0],
            signature: Uint8Array.from(Utils.toArray(signAdmission(parentTxid, [0]), 'hex')),
            signerKey
          }
        ]
      ])
    }
  }

  it('a frame whose token.overlayIdentityKey differs from the runtime’s configured key is refused unsafe_asset — never a rubber stamp for a self-minted admission', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    // The bundle claims a DIFFERENT overlay than this session is configured for,
    // and is internally self-consistent (σ_I really is signed by that same
    // claimed key) — exactly the "mint your own admissions" attack §9.10 closes.
    // A verifier that trusted `bundle.overlayIdentityKey` would validate this.
    const bundle = bundleFor(parent, attackerKey, attackerKey)
    const runtime = build()

    expect(await runtime.coverVerifier({ txid: tip.id('hex'), tx: tip }, bundle)).toEqual({
      ok: false,
      reason: 'unsafe_asset'
    })
  })

  it('a bundle whose claimed key EQUALS the runtime’s configured overlayIdentityKey, signed by that same key, covers normally', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const bundle = bundleFor(parent, OVERLAY_KEY, OVERLAY_KEY) // OVERLAY_KEY === ENDPOINTS.overlayIdentityKey
    const runtime = build()

    expect(await runtime.coverVerifier({ txid: tip.id('hex'), tx: tip }, bundle)).toEqual({
      ok: true,
      mustSubmit: [tip.id('hex')]
    })
  })
})

describe('submit maps the wire contract onto OverlayVerdict', () => {
  const tip = rootTx(100)
  const tipTxid = tip.id('hex')

  function runtimeWith(response: { ok: boolean; status: number; body: string }): MandalaRuntime {
    return build(
      {
        fetchImpl: async () => ({
          ok: response.ok,
          status: response.status,
          text: async () => response.body
        })
      },
      [],
      [{ txid: tipTxid, rawTx: tip.toBinary() }]
    )
  }

  it('admits, carrying the overlay’s own σ_I and admitted set', async () => {
    const signature = signAdmission(tipTxid, [0])
    const runtime = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({
        tm_mandala: { outputsToAdmit: [0], admissionSignature: signature, admissionIdentityKey: OVERLAY_KEY }
      })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toEqual({
      kind: 'admitted',
      outputsToAdmit: [0],
      signatureHex: signature,
      signerKey: OVERLAY_KEY
    })
  })

  it('an admitted response with no σ_I is NOT an admission: retryable ERR_NO_ADMISSION', async () => {
    const runtime = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [0] } })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toEqual({ kind: 'unavailable', code: 'ERR_NO_ADMISSION', retryable: true })
  })

  it('a σ_I by some other key, or over another admitted set, is ERR_BAD_ADMISSION', async () => {
    const impostor = PrivateKey.fromRandom()
    const foreign = impostor.sign(Utils.toArray(admissionMessageV2(tipTxid, [0]), 'utf8')).toDER('hex') as string
    const byImpostor = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [0], admissionSignature: foreign, admissionIdentityKey: impostor.toPublicKey().toString() } })
    })
    expect(await byImpostor.tokenDeps.submit(tipTxid)).toEqual({ kind: 'unavailable', code: 'ERR_BAD_ADMISSION', retryable: true })
    const wrongSet = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [0, 1], admissionSignature: signAdmission(tipTxid, [0]), admissionIdentityKey: OVERLAY_KEY } })
    })
    expect(await wrongSet.tokenDeps.submit(tipTxid)).toEqual({ kind: 'unavailable', code: 'ERR_BAD_ADMISSION', retryable: true })
  })

  it('a 400 with a manager verdict is a FINAL refusal', async () => {
    const runtime = runtimeWith({
      ok: false,
      status: 400,
      body: JSON.stringify({ status: 'error', code: 'ERR_CONSERVATION' })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toMatchObject({ kind: 'refused', code: 'ERR_CONSERVATION' })
  })

  it('a liftable refusal is retryable, and an eviction is its own verdict', async () => {
    const paused = runtimeWith({
      ok: false,
      status: 409,
      body: JSON.stringify({ status: 'error', code: 'ERR_PAUSED' })
    })
    expect(await paused.tokenDeps.submit(tipTxid)).toEqual({
      kind: 'unavailable',
      code: 'ERR_PAUSED',
      retryable: true
    })

    const evicted = runtimeWith({
      ok: false,
      status: 410,
      body: JSON.stringify({ status: 'error', code: 'ERR_EVICTED' })
    })
    expect(await evicted.tokenDeps.submit(tipTxid)).toEqual({ kind: 'evicted' })
  })

  it('a 500 with no structured body is unavailable, not a verdict', async () => {
    const runtime = runtimeWith({ ok: false, status: 500, body: '<html>nginx</html>' })
    expect(await runtime.tokenDeps.submit(tipTxid)).toMatchObject({ kind: 'unavailable', retryable: true })
  })

  it('bytes this device cannot produce stall rather than refuse', async () => {
    const runtime = build()
    expect(await runtime.tokenDeps.submit('ab'.repeat(32))).toEqual({
      kind: 'unavailable',
      code: 'ERR_LOCAL_BYTES',
      retryable: true
    })
  })

  // The overlay engine answers a transaction it has ALREADY applied with an
  // EMPTY admitted set (`isDupe`), and the lib reports that as a bare
  // "overlay rejected the transaction". That is the ordinary shop case — the
  // payee had signal and submitted first — and it is an admission on record,
  // not a refusal and not a fault. Read as a plain fault it stalled the payer's
  // queue row at 'queued' on every tick (2026-09-16). So it is resolved
  // through GET /admin/admission/:txid, and only that lookup decides.
  it('an empty admitted set is resolved as an admission already on record (the payee submitted first)', async () => {
    const signature = signAdmission(tipTxid, [0])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: tipTxid,
      outputsToAdmit: [0],
      signature,
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })
    const runtime = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [], coinsToRetain: [] } })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toEqual({
      kind: 'admitted',
      outputsToAdmit: [0],
      signatureHex: signature,
      signerKey: OVERLAY_KEY
    })
    expect(libFetchAdmission).toHaveBeenCalledWith(ENDPOINTS.overlayUrl, tipTxid, {})
  })

  it('an empty admitted set with nothing on record stays retryable, under its own code', async () => {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    const runtime = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [] } })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toEqual({
      kind: 'unavailable',
      code: 'ERR_EMPTY_ADMISSION',
      retryable: true
    })
  })

  it('an empty admitted set beside a FINAL verdict on record reports that verdict', async () => {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'refused',
      code: 'ERR_INPUT_SPENT',
      spendTxid: 'aa'.repeat(32)
    })
    const runtime = runtimeWith({
      ok: true,
      status: 200,
      body: JSON.stringify({ tm_mandala: { outputsToAdmit: [] } })
    })
    expect(await runtime.tokenDeps.submit(tipTxid)).toEqual({
      kind: 'refused',
      code: 'ERR_INPUT_SPENT',
      spendTxid: 'aa'.repeat(32)
    })
  })

  it('anything that is not a structured refusal is unavailable', () => {
    expect(verdictFromError(new Error('boom'))).toMatchObject({ kind: 'unavailable', retryable: true })
  })
})

// ───────────────── the drain step, over the runtime's own deps ─────────────────

describe('the drain step, driven by the runtime’s cover and submit', () => {
  /** Parent (unadmitted) ← tip. Both are this device's to submit. */
  async function chain(store: SettlementStore) {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const parentTxid = parent.id('hex')
    const tipTxid = tip.id('hex')
    const inputBeef = new Beef()
    inputBeef.mergeTransaction(parent)
    for (const [txid, state] of [
      [parentTxid, 'held'],
      [tipTxid, 'held']
    ] as const) {
      await store.upsertSettlement({
        txid,
        role: 'received',
        assetId: ASSET_ID,
        state,
        overlayUrl: ENDPOINTS.overlayUrl,
        overlayIdentityKey: OVERLAY_KEY
      })
    }
    return {
      parentTxid,
      tipTxid,
      reqs: [
        { txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBeef.toBinary() },
        { txid: parentTxid, rawTx: parent.toBinary() }
      ]
    }
  }

  it('submits parents-first and only then broadcasts the tip', async () => {
    const posted: string[] = []
    // The rows live in the shared database, so seeding them through one runtime
    // and driving the step through another (built once the request bytes are
    // known) is the same store either way.
    const { parentTxid, tipTxid, reqs } = await chain(build().store)
    const runtime = build(
      {
        fetchImpl: async (_url, init) => {
          // Every submit answers admitted, with a σ_I over whichever txid the
          // body carried — so the parent and the tip each get their own.
          const txid = txidOfSubmitBody(init)
          posted.push(txid)
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                tm_mandala: {
                  outputsToAdmit: [0],
                  admissionSignature: signAdmission(txid, [0]),
                  admissionIdentityKey: OVERLAY_KEY
                }
              })
          }
        }
      },
      [],
      reqs
    )

    const broadcasts: string[] = []
    const settlement = (await runtime.store.getSettlement(tipTxid)) as TokenSettlementRow
    const outcome = await postTokenStep(
      {
        store: runtime.store,
        cover: runtime.tokenDeps.cover,
        submit: runtime.tokenDeps.submit,
        broadcast: async txid => {
          broadcasts.push(txid)
          return 'success'
        }
      },
      settlement,
      { txid: tipTxid, owned: true }
    )

    expect(outcome).toBe('success')
    // Parents first, tip last, and the broadcast only after every submit.
    expect(posted).toEqual([parentTxid, tipTxid])
    expect(broadcasts).toEqual([tipTxid])
    expect((await runtime.store.getSettlement(parentTxid))?.state).toBe('admitted')
    expect((await runtime.store.getSettlement(tipTxid))?.state).toBe('broadcast')
  })

  it('a retryable verdict stalls the step and leaves every row exactly where it was', async () => {
    const { parentTxid, tipTxid, reqs } = await chain(build().store)
    const runtime = build(
      {
        fetchImpl: async () => ({
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ status: 'error', code: 'ERR_PAUSED' })
        })
      },
      [],
      reqs
    )

    const broadcasts: string[] = []
    const settlement = (await runtime.store.getSettlement(tipTxid)) as TokenSettlementRow
    const outcome = await postTokenStep(
      {
        store: runtime.store,
        cover: runtime.tokenDeps.cover,
        submit: runtime.tokenDeps.submit,
        broadcast: async txid => {
          broadcasts.push(txid)
          return 'success'
        }
      },
      settlement,
      { txid: tipTxid, owned: true }
    )

    expect(outcome).toBe('serviceError')
    expect(broadcasts).toEqual([])
    expect((await runtime.store.getSettlement(parentTxid))?.state).toBe('held')
    expect((await runtime.store.getSettlement(tipTxid))?.state).toBe('held')
  })
})

// ───────────────── resendTransfer — the token Resend, over the message box ─────────────────

describe('resendTransfer — re-delivers a token transfer over the message box', () => {
  it('rebuilds the notification from the action’s own marker and this device’s bytes, and sends it', async () => {
    const tip = rootTx(2500)
    const txid = tip.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(tip)
    const box = messageBox()
    const wallet = {
      ...fakeWallet(),
      listActions: jest.fn(async () => ({
        actions: [
          {
            txid,
            labels: ['mandala', 'localpay', PAYEE],
            outputs: [
              {
                outputIndex: 0,
                customInstructions: JSON.stringify({ recipient: PAYEE, senderBlinded: PAYER, keyID: 'p s' })
              }
            ]
          }
        ]
      }))
    }
    const runtime = build({ wallet: wallet as never, messageBox: async () => box as never })

    const outcome = await runtime.resendTransfer(txid, { refetch: async () => beef.toBinaryAtomic(txid) })

    expect(outcome).toEqual({ ok: true })
    expect(wallet.listActions).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['mandala'], includeOutputs: true, includeLabels: true }),
      'urn:test:admin'
    )
    expect(box.sendMessage).toHaveBeenCalledWith({
      recipient: PAYEE,
      messageBox: 'mandala-payments',
      body: expect.objectContaining({
        assetId: ASSET_ID,
        amount: '2500',
        sender: PAYER,
        senderMode: 'blinded',
        keyID: 'p s',
        outputIndex: 0
      })
    })
  })

  it('is no_record, and sends nothing, on a chain with no Mandala deployment', async () => {
    const box = messageBox()
    const runtime = build({ chain: 'test', endpoints: undefined, messageBox: async () => box as never })
    await expect(runtime.resendTransfer('ab'.repeat(32), { refetch: async () => undefined })).resolves.toEqual({
      ok: false,
      reason: 'no_record'
    })
    expect(box.sendMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── fetchAdmission (FIX J / FIX H) ─────────────────────────

describe('fetchAdmission — GET /admin/admission/:txid, mapped and FIX-H-verified', () => {
  const TXID = '77'.repeat(32)

  it('a 404 (undefined) stays undefined, and carries no payloadHash when this device holds no linkage for the txid', async () => {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    const runtime = build()
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toBeUndefined()
    expect(libFetchAdmission).toHaveBeenCalledWith(ENDPOINTS.overlayUrl, TXID, {})
  })

  it('amendment §9.1/§9.3: passes payloadHash(bytes) of the STORED linkage payload when this device holds one for the txid', async () => {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    const runtime = build()
    const payloadBytes = Uint8Array.from([1, 2, 3, 4, 5])
    await runtime.store.putLinkage({
      txid: TXID,
      payloadBytes,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      source: 'forwarded',
      createdAt: new Date().toISOString()
    })

    await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)

    expect(libFetchAdmission).toHaveBeenCalledWith(ENDPOINTS.overlayUrl, TXID, {
      payloadHash: payloadHash(payloadBytes)
    })
  })

  it('maps evicted, refused and unavailable verdicts straight through', async () => {
    const runtime = build()
    ;(libFetchAdmission as jest.Mock).mockResolvedValueOnce({ kind: 'evicted' })
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toEqual({ kind: 'evicted' })

    ;(libFetchAdmission as jest.Mock).mockResolvedValueOnce({
      kind: 'refused',
      code: 'ERR_SHAPE',
      spendTxid: 'aa'.repeat(32)
    })
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toEqual({
      kind: 'refused',
      code: 'ERR_SHAPE',
      spendTxid: 'aa'.repeat(32)
    })

    ;(libFetchAdmission as jest.Mock).mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'ERR_UNAVAILABLE',
      retryable: true
    })
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toEqual({
      kind: 'unavailable',
      code: 'ERR_UNAVAILABLE',
      retryable: true
    })
  })

  it('a verified admitted answer carries the overlay’s own σ_I', async () => {
    const signature = signAdmission(TXID, [0])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: TXID,
      outputsToAdmit: [0],
      signature,
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })
    const runtime = build()
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toEqual({
      kind: 'admitted',
      outputsToAdmit: [0],
      signatureHex: signature,
      signerKey: OVERLAY_KEY
    })
  })

  it('FIX H: an admitted answer that does not verify against THIS session’s overlay key is absent, never a decline', async () => {
    const otherKey = new PrivateKey(321).toPublicKey().toString()
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: TXID,
      outputsToAdmit: [0],
      signature: signAdmission(TXID, [0]), // signed by OVERLAY_PRIV, claimed as otherKey
      signerKey: otherKey,
      at: Date.now()
    })
    const runtime = build()
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toBeUndefined()
  })

  it('a lib throw is unavailable, never a decline', async () => {
    ;(libFetchAdmission as jest.Mock).mockRejectedValue(new Error('network down'))
    const runtime = build()
    expect(await runtime.fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toEqual({
      kind: 'unavailable',
      code: 'ERR_UNAVAILABLE',
      retryable: true
    })
  })
})

// ───────────────────────── recoverStaleAdmissions (FIX C) ─────────────────────────

describe('recoverStaleAdmissions — FIX C recovery', () => {
  const OLD_TXID = '55'.repeat(32)
  const STALE_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString() // > 5 min horizon

  it('advances a stale handed_over row when the overlay verifies an admission this device never cached', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: OLD_TXID,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'handed_over',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: STALE_AGO
    })
    const signature = signAdmission(OLD_TXID, [0])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: OLD_TXID,
      outputsToAdmit: [0],
      signature,
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })

    expect(await runtime.recoverStaleAdmissions()).toBe(1)
    expect((await runtime.store.getSettlement(OLD_TXID))?.state).toBe('admitted')
    expect((await runtime.store.getAdmission(OLD_TXID))?.signatureHex).toBe(signature)
  })

  it('never asks about a row still inside the recovery horizon', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: OLD_TXID,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'handed_over',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    expect(await runtime.recoverStaleAdmissions()).toBe(0)
    expect(libFetchAdmission).not.toHaveBeenCalled()
  })

  it('never asks about a row that already has a cached admission — the ordinary drain owns it', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: OLD_TXID,
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: STALE_AGO
    })
    await runtime.store.putAdmission({
      txid: OLD_TXID,
      outputsToAdmit: [0],
      signatureHex: signAdmission(OLD_TXID, [0]),
      signerKey: OVERLAY_KEY,
      source: 'bundle',
      obtainedAt: new Date().toISOString()
    })
    expect(await runtime.recoverStaleAdmissions()).toBe(0)
    expect(libFetchAdmission).not.toHaveBeenCalled()
  })

  it('leaves the row exactly where it was when the overlay has no better answer', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: OLD_TXID,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'handed_over',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: STALE_AGO
    })
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    expect(await runtime.recoverStaleAdmissions()).toBe(0)
    expect((await runtime.store.getSettlement(OLD_TXID))?.state).toBe('handed_over')
  })
})

// ───────────────────────── nearby blinding ─────────────────────────

describe('nearby blinding — lockToPayee reserves, the build commits, the drain prunes', () => {
  it('reserve → build → commit lands the record under the txid', async () => {
    const runtime = build({ wallet: blindingWallet() as never })
    const keyID = 'nearby-reserve-commit'
    const txid = '11'.repeat(32)

    await runtime.lockToPayee({ assetId: ASSET_ID, amount: 10, recipientKey: PAYEE, keyID })
    expect((await blindingListReserved()).some(r => r.keyID === keyID)).toBe(true)
    expect(await blindingGet(txid)).toBeUndefined()

    await runtime.tokenBuildDeps.commitBlinding?.(keyID, txid)

    const record = await blindingGet(txid)
    expect(record?.keyID).toBe(keyID)
    expect((await blindingListReserved()).some(r => r.keyID === keyID)).toBe(false)
  })

  it('an abandoned reservation is left for pruneBlindingReservations; a fresh one is not touched', async () => {
    const abandonedKeyID = 'nearby-abort-prune'
    const stale = build({ wallet: blindingWallet() as never, now: () => new Date(Date.now() - 25 * 60 * 60 * 1000) })
    await stale.lockToPayee({ assetId: ASSET_ID, amount: 10, recipientKey: PAYEE, keyID: abandonedKeyID })
    expect((await blindingListReserved()).some(r => r.keyID === abandonedKeyID)).toBe(true)

    const freshKeyID = 'nearby-fresh-reservation'
    const fresh = build({ wallet: blindingWallet() as never })
    await fresh.lockToPayee({ assetId: ASSET_ID, amount: 10, recipientKey: PAYEE, keyID: freshKeyID })

    const removed = await fresh.pruneBlindingReservations()
    expect(removed).toBeGreaterThanOrEqual(1)
    const stillReserved = await blindingListReserved()
    expect(stillReserved.some(r => r.keyID === abandonedKeyID)).toBe(false)
    expect(stillReserved.some(r => r.keyID === freshKeyID)).toBe(true)
  })
})

// ───────────────────────── sendToHandle evidence (§4.5) ─────────────────────────

describe('sendToHandle — caches the handle rail’s own evidence', () => {
  it('derives the tip’s token edges and caches the off-chain linkage after a successful send', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const txid = tip.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(tip)
    const atomicBeef = beef.toBinaryAtomic(txid)
    const offChainValues = [1, 2, 3, 4]

    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true, atomicBeef, offChainValues })

    const runtime = build()
    const result = await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })
    expect(result).toEqual({ kind: 'sent', txid, settled: false, notified: true })

    expect(await runtime.store.parentsOf(txid)).toEqual([
      { childTxid: txid, parentTxid: parent.id('hex'), parentVout: 0 }
    ])
    const linkage = await runtime.store.getLinkage(txid)
    expect(linkage?.source).toBe('minted')
    expect(Array.from(linkage?.payloadBytes ?? [])).toEqual(offChainValues)
  })

  it('never records the tip as admitted, even if the lib hands a σ_I back', async () => {
    // Defence in depth: the hand-over rail asks for no admission, so a σ_I on
    // the result is a contradiction. It must not be able to open the row
    // `admitted` and skip the drain's own submit of these bytes.
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(tip)

    ;(transferTokens as jest.Mock).mockResolvedValue({
      txid,
      notified: true,
      handedOver: true,
      atomicBeef: beef.toBinaryAtomic(txid),
      offChainValues: [9, 9],
      outputsToAdmit: [0],
      admissionSignature: signAdmission(txid, [0]),
      admissionIdentityKey: OVERLAY_KEY
    })

    const runtime = build()
    const result = await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })
    expect(result).toEqual({ kind: 'sent', txid, settled: false, notified: true })
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
    expect(await runtime.store.getAdmission(txid)).toBeUndefined()
    // The linkage the drain will submit with is still cached.
    expect(await runtime.store.getLinkage(txid)).toBeDefined()
  })

  it('still journals the settlement row when the lib carries neither field (defensive, never blocks the payment)', async () => {
    const txid = '66'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: true })
    const runtime = build()
    const result = await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 5 })
    expect(result).toEqual({ kind: 'sent', txid, settled: false, notified: true })
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
    expect(await runtime.store.getLinkage(txid)).toBeUndefined()
  })
})

// ─────────────── the hand-over rail, end to end over the real tables ───────────────

describe('hand-over-first, and the drain that finishes it', () => {
  /**
   * The txid of a submit body that CARRIES off-chain values: the facilitator
   * frames those as `varint(len(beef)) || beef || offChainValues`, so the plain
   * `txidOfSubmitBody` would read the length prefix as BEEF.
   */
  const txidOfFramedSubmitBody = (init: unknown): string => {
    const { headers, body } = init as { headers: Record<string, string>; body: Uint8Array }
    if (headers['x-includes-off-chain-values'] !== 'true') return txidOfSubmitBody(init)
    const reader = new Utils.Reader(Array.from(body))
    const length = reader.readVarIntNum()
    const beef = Beef.fromBinary(reader.read(length))
    return beef.atomicTxid ?? beef.txs[beef.txs.length - 1].txid
  }

  /** Every submit answers admitted, with a σ_I over whichever txid the body carried. */
  const admittingFetch = (posted: string[]) => async (_url: unknown, init: unknown) => {
    const txid = txidOfFramedSubmitBody(init)
    posted.push(txid)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          tm_mandala: {
            outputsToAdmit: [0],
            admissionSignature: signAdmission(txid, [0]),
            admissionIdentityKey: OVERLAY_KEY
          }
        })
    }
  }

  it('the PAYER’s handed_over row is drainable: the drain submits its bytes and broadcasts', async () => {
    // The tx is `noSend` in the wallet's own storage, so its bytes come back
    // from `findProvenTxReqs`; its linkage payload is the one `sendToHandle`
    // cached. Without both, a hand-over could only ever be settled by the
    // payee.
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(tip)
    const offChainValues = [4, 5, 6]
    ;(transferTokens as jest.Mock).mockResolvedValue({
      txid,
      notified: true,
      handedOver: true,
      atomicBeef: beef.toBinaryAtomic(txid),
      offChainValues
    })

    const sender = build()
    await sender.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })
    expect((await sender.store.getSettlement(txid))?.state).toBe('handed_over')

    const posted: string[] = []
    const runtime = build(
      { fetchImpl: admittingFetch(posted) as never },
      [],
      [{ txid, rawTx: tip.toBinary() }]
    )

    const broadcasts: string[] = []
    const row = (await runtime.store.getSettlement(txid)) as TokenSettlementRow
    const outcome = await postTokenStep(
      {
        store: runtime.store,
        cover: runtime.tokenDeps.cover,
        submit: runtime.tokenDeps.submit,
        broadcast: async id => {
          broadcasts.push(id)
          return 'success'
        }
      },
      row,
      { txid, owned: true }
    )

    expect(outcome).toBe('success')
    expect(posted).toEqual([txid])
    expect(broadcasts).toEqual([txid])
    expect((await runtime.store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('the PAYEE’s settle writes held rows + linkage for a 1-hop mustSubmit, and never submits inline', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }])
    const parentTxid = parent.id('hex')
    const tipTxid = tip.id('hex')
    const bundle = new Beef()
    bundle.mergeTransaction(tip)

    const bytesFor = (id: string) => {
      const tx = bundle.findAtomicTransaction(id)
      if (!tx) return undefined
      return {
        beef: tx.toAtomicBEEF(true),
        offChainValues: id === tipTxid ? [1, 1] : [2, 2]
      }
    }

    const fetchImpl = jest.fn(async () => {
      throw new Error('crediting must not submit inline')
    })
    const runtime = build({ fetchImpl: fetchImpl as never })

    ;(receiveTokens as jest.Mock).mockImplementation(async (p: { settle: (a: unknown) => Promise<void> }) => {
      await p.settle({ txid: tipTxid, mustSubmit: [parentTxid, tipTxid], bytesFor })
      return {
        accepted: [
          {
            id: 'msg-h',
            assetId: ASSET_ID,
            amount: '60',
            sender: PAYER,
            keyID: 'k',
            protocolID: [2, 'mandala token'],
            transaction: bundle.toBinaryAtomic(tipTxid),
            outputIndex: 0,
            label: 'Acme Dollar',
            decimals: 2,
            admissionVerified: false,
            handedOver: true,
            covered: true,
            settled: false
          }
        ],
        failed: []
      }
    })

    expect(await runtime.receiveFromInbox()).toEqual({ credited: 1, failed: 0 })
    // Nothing was submitted while crediting: the obligation is durable instead.
    expect(fetchImpl).not.toHaveBeenCalled()
    for (const id of [parentTxid, tipTxid]) {
      const row = await runtime.store.getSettlement(id)
      expect(row?.state).toBe('held')
      expect(row?.role).toBe('received')
      expect(row?.assetId).toBe(ASSET_ID)
      // The CONFIGURED deployment, never one the payer named.
      expect(row?.overlayIdentityKey).toBe(OVERLAY_KEY)
      expect(await runtime.store.getLinkage(id)).toBeDefined()
    }
    expect(Array.from((await runtime.store.getLinkage(parentTxid))?.payloadBytes ?? [])).toEqual([2, 2])
    expect(await runtime.store.parentsOf(tipTxid)).toEqual([
      { childTxid: tipTxid, parentTxid, parentVout: 0 }
    ])

    // …and the NEXT drain tick submits parents-first, tip last.
    const inputBeef = new Beef()
    inputBeef.mergeTransaction(parent)
    const posted: string[] = []
    const draining = build({ fetchImpl: admittingFetch(posted) as never }, [], [
      { txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBeef.toBinary() },
      { txid: parentTxid, rawTx: parent.toBinary() }
    ])
    const broadcasts: string[] = []
    const outcome = await postTokenStep(
      {
        store: draining.store,
        cover: draining.tokenDeps.cover,
        submit: draining.tokenDeps.submit,
        broadcast: async id => {
          broadcasts.push(id)
          return 'success'
        }
      },
      (await draining.store.getSettlement(tipTxid)) as TokenSettlementRow,
      { txid: tipTxid, owned: true }
    )
    expect(outcome).toBe('success')
    expect(posted).toEqual([parentTxid, tipTxid])
    expect(broadcasts).toEqual([tipTxid])
    expect((await draining.store.getSettlement(parentTxid))?.state).toBe('admitted')
    expect((await draining.store.getSettlement(tipTxid))?.state).toBe('broadcast')
  })

  it('a credit whose asset cannot be read writes no row and is left for the next pass (never silently credited)', async () => {
    const runtime = build()
    ;(receiveTokens as jest.Mock).mockImplementation(async (p: { settle: (a: unknown) => Promise<void> }) => {
      await p.settle({ txid: 'ab'.repeat(32), mustSubmit: ['ab'.repeat(32)], bytesFor: () => undefined })
      return { accepted: [], failed: [] }
    })
    await expect(runtime.receiveFromInbox()).rejects.toThrow(/settlement row before crediting/)
    expect(await runtime.store.listSettlements()).toHaveLength(0)
  })
})

// ───────────────────────── assetStatus / refreshAssetStatus ─────────────────────────

describe('assetStatus — regulatory/registry facts for the UI', () => {
  it('reports paused, the frozen-outpoint sum, and the access mode from the overlay’s admin state', async () => {
    ;(resolveAssetState as jest.Mock).mockResolvedValue({
      assetId: ASSET_ID,
      issuerIdentityKey: PAYER,
      isPaused: true,
      accessMode: 'denylist',
      blockedIdentities: [],
      allowedIdentities: [],
      frozenOutpoints: [
        { outpoint: 'aa'.repeat(32) + '.0', amount: 30, owner: PAYEE, reason: 'kyc' },
        { outpoint: 'bb'.repeat(32) + '.1', amount: 12, owner: PAYEE, reason: 'kyc' }
      ],
      evictedOutpoints: []
    })
    const status = await build().assetStatus(ASSET_ID)
    expect(status.paused).toBe(true)
    expect(status.frozenBaseUnits).toBe(42)
    expect(status.accessMode).toBe('denylist')
  })

  it('an active registry reports self-admission and answers recipientAdmitted per key', async () => {
    const rows: OverlayRegistryRow[] = [
      {
        identityKey: PAYEE,
        status: 'admitted',
        txid: 'cc'.repeat(32),
        outputIndex: 0,
        admitSeq: 2,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    ;(fetchRegistry as jest.Mock).mockResolvedValue(rows)
    const status = await build().assetStatus(ASSET_ID)
    // PAYER (this wallet's own identity, per fakeWallet) never appears in the rows.
    expect(status.selfAdmitted).toBe(false)
    expect(await status.recipientAdmitted(PAYEE)).toBe(true)
    expect(await status.recipientAdmitted('03'.padEnd(66, '9'))).toBe(false)
  })

  it('an inactive registry reads as undefined, never as false', async () => {
    ;(fetchRegistry as jest.Mock).mockResolvedValue([])
    const status = await build().assetStatus(ASSET_ID)
    expect(status.selfAdmitted).toBeUndefined()
    expect(await status.recipientAdmitted(PAYEE)).toBeUndefined()
  })

  it('reports whether the asset’s metadata resolved', async () => {
    expect((await build({ resolveMetadata: async () => null }).assetStatus(ASSET_ID)).metadataResolved).toBe(false)
    expect((await build().assetStatus(ASSET_ID)).metadataResolved).toBe(true)
  })

  it('carries the configured MessageBox host', async () => {
    expect((await build().assetStatus(ASSET_ID)).messageBoxUrl).toBe(ENDPOINTS.messageBoxUrl)
  })

  it('caches for ~10s, and refreshAssetStatus forces a fresh read past it', async () => {
    const runtime = build()
    await runtime.assetStatus(ASSET_ID)
    await runtime.assetStatus(ASSET_ID)
    expect(resolveAssetState).toHaveBeenCalledTimes(1)

    await runtime.refreshAssetStatus(ASSET_ID)
    expect(resolveAssetState).toHaveBeenCalledTimes(2)
    expect((resolveAssetState as jest.Mock).mock.calls[1][1]).toEqual({ force: true })
  })

  it('never throws when the overlay is unreachable — unknown reads as the least alarming answer', async () => {
    ;(resolveAssetState as jest.Mock).mockRejectedValue(new Error('overlay down'))
    ;(fetchRegistry as jest.Mock).mockRejectedValue(new Error('overlay down'))
    const status = await build().assetStatus(ASSET_ID)
    expect(status.paused).toBe(false)
    expect(status.frozenBaseUnits).toBe(0)
    expect(status.selfAdmitted).toBeUndefined()
  })
})

// ──────────── the overlay a fetch addresses, and the txid it answers about ────────────

/**
 * Two ways an "admission" can be true and still prove nothing about the payment
 * in hand, both of which the runtime has to close because `verifyFetchedAdmission`
 * cannot: it checks the signature over whatever the BODY said, against the
 * configured key — so it catches a forged σ_I and nothing else.
 */
describe('fetchAdmission is pinned to this deployment (§9.10)', () => {
  const TXID = '41'.repeat(32)

  it('asks THIS session’s configured overlay, whatever URL the caller names', async () => {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    const runtime = build()

    expect(await runtime.fetchAdmission('https://payer-controlled.example', TXID)).toBeUndefined()

    // The argument is advisory: every caller sources it from a settlement row,
    // whose copy began life on a counterparty's frame.
    expect(libFetchAdmission).toHaveBeenCalledWith(ENDPOINTS.overlayUrl, TXID, {})
  })

  it('an admitted answer about a DIFFERENT txid is absent, however genuine its σ_I', async () => {
    const somebodyElse = '42'.repeat(32)
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: somebodyElse,
      outputsToAdmit: [0],
      // A REAL admission, signed by the real overlay — for another transaction.
      signature: signAdmission(somebodyElse, [0]),
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })

    expect(await build().fetchAdmission(ENDPOINTS.overlayUrl, TXID)).toBeUndefined()
  })

  it('recovery asks the configured overlay even when the stale row names another', async () => {
    const txid = '43'.repeat(32)
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid,
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      // What `reconcileSettlements` writes from a frame: the PAYER's claim.
      overlayUrl: 'https://payer-controlled.example',
      overlayIdentityKey: OVERLAY_KEY,
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    })
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)

    await runtime.recoverStaleAdmissions()

    expect(libFetchAdmission).toHaveBeenCalledWith(ENDPOINTS.overlayUrl, txid, {})
  })
})

// ───────────── the settlement-durability hooks (receiver held / payer hand-over) ─────────────

/** A v4 token frame, carrying whatever the payer CLAIMS about the deployment. */
function tokenFrame(args: {
  tip: Transaction
  ancestors?: Transaction[]
  linkage?: { txid: string; payload: Uint8Array }[]
  admissions?: { txid: string; outputsToAdmit: number[]; signature: Uint8Array; signerKey: string }[]
  overlayUrl?: string
  overlayIdentityKey?: string
}) {
  const beef = new Beef()
  for (const tx of args.ancestors ?? []) beef.mergeTransaction(tx)
  beef.mergeTransaction(args.tip)
  return {
    kind: 'token',
    senderIdentityKey: PAYER,
    outputIndex: 0,
    transaction: Uint8Array.from(beef.toBinaryAtomic(args.tip.id('hex'))),
    token: {
      assetId: ASSET_ID,
      overlayUrl: args.overlayUrl ?? ENDPOINTS.overlayUrl,
      overlayIdentityKey: args.overlayIdentityKey ?? OVERLAY_KEY,
      certificates: [],
      linkage: args.linkage ?? [],
      admissions: args.admissions ?? []
    }
  }
}

/** σ_I bytes as a frame carries them, by the overlay or by an impostor. */
function admissionBytes(txid: string, outputsToAdmit: number[], priv = OVERLAY_PRIV): Uint8Array {
  const der = priv.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8')).toDER('hex') as string
  return Uint8Array.from(Utils.toArray(der, 'hex'))
}

describe('onTokenHeld — the receiver’s row, written before the credit', () => {
  it('writes a held row and the frame’s evidence, under the CONFIGURED overlay', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }], 60)
    const txid = tip.id('hex')
    const payload = Uint8Array.from([7, 7, 7])
    const runtime = build()
    const seen: number[] = []
    runtime.subscribe(() => seen.push(1))

    await runtime.onTokenHeld(
      tokenFrame({
        tip,
        ancestors: [parent],
        linkage: [{ txid: parent.id('hex'), payload }],
        // The payer's claim about where this asset lives. It is data.
        overlayUrl: 'https://payer-controlled.example',
        overlayIdentityKey: new PrivateKey(555).toPublicKey().toString()
      }),
      txid
    )

    const row = await runtime.store.getSettlement(txid)
    expect(row?.state).toBe('held')
    expect(row?.role).toBe('received')
    expect(row?.assetId).toBe(ASSET_ID)
    expect(row?.counterpartyKey).toBe(PAYER)
    // The figure the activity row prints, read off the tip's own script: a
    // nearby row with no amount rendered as "+0 sats" (2026-09-16).
    expect(row?.amountBaseUnits).toBe(60)
    // Never the frame's: the row is what later tells recovery where to ask.
    expect(row?.overlayUrl).toBe(ENDPOINTS.overlayUrl)
    expect(row?.overlayIdentityKey).toBe(OVERLAY_KEY)

    expect(await runtime.store.parentsOf(txid)).toEqual([
      { childTxid: txid, parentTxid: parent.id('hex'), parentVout: 0 }
    ])
    expect(Array.from((await runtime.store.getLinkage(parent.id('hex')))?.payloadBytes ?? [])).toEqual([7, 7, 7])
    expect(seen).toHaveLength(1)
  })

  it('caches only the σ_I this overlay actually signed (FIX H)', async () => {
    const genuine = rootTx(10)
    const forged = rootTx(11)
    const wrongKey = rootTx(12)
    const impostor = new PrivateKey(4242)
    const tip = txSpending([{ tx: genuine, vout: 0 }], 5)
    const runtime = build()

    await runtime.onTokenHeld(
      tokenFrame({
        tip,
        ancestors: [genuine],
        admissions: [
          {
            txid: genuine.id('hex'),
            outputsToAdmit: [0],
            signature: admissionBytes(genuine.id('hex'), [0]),
            signerKey: OVERLAY_KEY
          },
          {
            // This overlay's key, somebody else's pen.
            txid: forged.id('hex'),
            outputsToAdmit: [0],
            signature: admissionBytes(forged.id('hex'), [0], impostor),
            signerKey: OVERLAY_KEY
          },
          {
            // Honest about the pen, but it is not the key this wallet trusts.
            txid: wrongKey.id('hex'),
            outputsToAdmit: [0],
            signature: admissionBytes(wrongKey.id('hex'), [0], impostor),
            signerKey: impostor.toPublicKey().toString()
          }
        ]
      }),
      tip.id('hex')
    )

    expect((await runtime.store.getAdmission(genuine.id('hex')))?.signerKey).toBe(OVERLAY_KEY)
    // A cached entry can SKIP a /submit, so a forged one would strand a payment
    // that was never admitted — and propagate the lie to the next hop.
    expect(await runtime.store.getAdmission(forged.id('hex'))).toBeUndefined()
    expect(await runtime.store.getAdmission(wrongKey.id('hex'))).toBeUndefined()
  })

  it('never drags a row that has already settled back to held', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid,
      role: 'received',
      assetId: ASSET_ID,
      state: 'admitted',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })

    await runtime.onTokenHeld(tokenFrame({ tip }), txid)

    expect((await runtime.store.getSettlement(txid))?.state).toBe('admitted')
  })

  it('onTokenCredited re-derives the same facts after the credit', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const runtime = build()

    await runtime.onTokenCredited(tokenFrame({ tip }) as never, txid)

    expect((await runtime.store.getSettlement(txid))?.state).toBe('held')
  })
})

describe('onTokenHandedOver — the payer’s row, written while the frame is still plaintext', () => {
  it('parks a sent row, then lets a hand-over advance it', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const runtime = build()

    await runtime.onTokenHandedOver(tokenFrame({ tip }), txid, 'parked')
    const parked = await runtime.store.getSettlement(txid)
    expect(parked?.state).toBe('parked')
    expect(parked?.role).toBe('sent')
    expect(parked?.overlayUrl).toBe(ENDPOINTS.overlayUrl)
    // The payer's own (blinded) key is on the frame; it is not the payee.
    expect(parked?.counterpartyKey).toBeUndefined()
    // The payee's output, index 0 on the payer's own frame — never the change.
    expect(parked?.amountBaseUnits).toBe(40)

    await runtime.onTokenHandedOver(tokenFrame({ tip }), txid, 'handed_over')
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
  })

  it('caches the evidence the sealed queue row could never give back', async () => {
    const parent = rootTx(100)
    const tip = txSpending([{ tx: parent, vout: 0 }], 60)
    const txid = tip.id('hex')
    const runtime = build()

    await runtime.onTokenHandedOver(
      tokenFrame({ tip, ancestors: [parent], linkage: [{ txid, payload: Uint8Array.from([5, 5]) }] }),
      txid,
      'handed_over'
    )

    expect(Array.from((await runtime.store.getLinkage(txid))?.payloadBytes ?? [])).toEqual([5, 5])
    expect(await runtime.store.parentsOf(txid)).toEqual([
      { childTxid: txid, parentTxid: parent.id('hex'), parentVout: 0 }
    ])
  })

  it('never moves a row the overlay has already ruled on', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'admitted',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })

    await runtime.onTokenHandedOver(tokenFrame({ tip }), txid, 'handed_over')

    expect((await runtime.store.getSettlement(txid))?.state).toBe('admitted')
  })
})

describe('verifyAdmission — the FIX H anchor the runtime hands its machinery', () => {
  it('verifies against the configured key, and no caller may name another', async () => {
    const txid = '44'.repeat(32)
    const runtime = build()

    expect(
      await runtime.verifyAdmission({
        txid,
        outputsToAdmit: [0],
        signature: admissionBytes(txid, [0]),
        signerKey: OVERLAY_KEY
      })
    ).toBe(true)

    const impostor = new PrivateKey(4242)
    expect(
      await runtime.verifyAdmission({
        txid,
        outputsToAdmit: [0],
        signature: admissionBytes(txid, [0], impostor),
        signerKey: impostor.toPublicKey().toString()
      })
    ).toBe(false)
  })

  it('is the same function the drain and the payer’s build are given', () => {
    const runtime = build()
    const deps = runtime.tokenDeps as unknown as { verifyAdmission?: unknown; overlayIdentityKey?: string }
    const build_ = runtime.tokenBuildDeps as unknown as { verifyAdmission?: unknown; overlayIdentityKey?: string }
    expect(deps.verifyAdmission).toBe(runtime.verifyAdmission)
    expect(deps.overlayIdentityKey).toBe(OVERLAY_KEY)
    expect(build_.verifyAdmission).toBe(runtime.verifyAdmission)
    expect(build_.overlayIdentityKey).toBe(OVERLAY_KEY)
  })
})

// ───────────── submit resolves a FOREIGN ancestor's bytes (spec §1.6) ─────────────

describe('submit finds the bytes of a hop this wallet never built', () => {
  it('serves a 2-hop chain’s middle transaction out of the tip’s own stored BEEF', async () => {
    // Alice → Bob → us. Only the tip is this wallet's: `findProvenTxReqs` has a
    // row for it and for nothing else, exactly as after an internalize.
    const root = rootTx(100)
    const middle = txSpending([{ tx: root, vout: 0 }], 60)
    const tip = txSpending([{ tx: middle, vout: 0 }], 30)
    const middleTxid = middle.id('hex')
    const tipTxid = tip.id('hex')

    const ancestry = new Beef()
    ancestry.mergeTransaction(root)
    ancestry.mergeTransaction(middle)

    const seeded = build().store
    for (const txid of [middleTxid, tipTxid]) {
      await seeded.upsertSettlement({
        txid,
        role: 'received',
        assetId: ASSET_ID,
        state: 'held',
        overlayUrl: ENDPOINTS.overlayUrl,
        overlayIdentityKey: OVERLAY_KEY
      })
    }

    const posted: string[] = []
    const runtime = build(
      {
        fetchImpl: async (_url, init) => {
          const txid = txidOfSubmitBody(init)
          posted.push(txid)
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                tm_mandala: {
                  outputsToAdmit: [0],
                  admissionSignature: signAdmission(txid, [0]),
                  admissionIdentityKey: OVERLAY_KEY
                }
              })
          }
        }
      },
      [],
      // No request row for `middle` — it is nobody's transaction here.
      [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: ancestry.toBinary() }]
    )

    expect(await runtime.tokenDeps.submit(middleTxid)).toMatchObject({ kind: 'admitted', outputsToAdmit: [0] })
    // The ancestor went out as ITS OWN atomic BEEF, not as the tip's.
    expect(posted).toEqual([middleTxid])
  })

  it('still stalls, rather than refusing, when no local BEEF holds the txid', async () => {
    const runtime = build()
    await runtime.store.upsertSettlement({
      txid: 'ee'.repeat(32),
      role: 'received',
      assetId: ASSET_ID,
      state: 'held',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    expect(await runtime.tokenDeps.submit('ff'.repeat(32))).toEqual({
      kind: 'unavailable',
      code: 'ERR_LOCAL_BYTES',
      retryable: true
    })
  })
})

// ───────────── the lib's own journals, driven from the drain tick ─────────────

describe('reconcileJournals — the handle rail’s recovery, on the drain tick', () => {
  it('a drain tick drives BOTH lib journals', async () => {
    const box = messageBox()
    const runtime = build({ messageBox: async () => box as never })

    await runtime.drainNow()

    expect(reconcileWallet).toHaveBeenCalledTimes(1)
    // Bound to the admin originator, like every other lib call from here.
    expect((reconcileWallet as jest.Mock).mock.calls[0][0]).toBeTruthy()
    expect(reconcileNotifications).toHaveBeenCalledTimes(1)
    expect((reconcileNotifications as jest.Mock).mock.calls[0][0]).toBe(box)
  })

  it('runs the wallet lib call as the admin originator', async () => {
    const wallet = fakeWallet()
    const runtime = build({ wallet: wallet as never })
    await runtime.reconcileJournals()
    const bound = (reconcileWallet as jest.Mock).mock.calls[0][0] as { getPublicKey: (a: unknown) => Promise<unknown> }
    await bound.getPublicKey({ identityKey: true })
    expect(wallet.getPublicKey).toHaveBeenCalledWith({ identityKey: true }, 'urn:test:admin')
  })

  it('never throws — a journal that cannot be driven is left for the next pass', async () => {
    ;(reconcileWallet as jest.Mock).mockRejectedValue(new Error('overlay down'))
    ;(reconcileNotifications as jest.Mock).mockRejectedValue(new Error('messagebox down'))
    const runtime = build()

    await expect(runtime.drainNow()).resolves.toBeUndefined()
    expect(reconcileWallet).toHaveBeenCalledTimes(1)
    expect(reconcileNotifications).toHaveBeenCalledTimes(1)
  })

  it('a MessageBox that will not open does not stop the wallet half', async () => {
    const runtime = build({
      messageBox: async () => {
        throw new Error('no messagebox configured')
      }
    })
    await expect(runtime.reconcileJournals()).resolves.toBeUndefined()
    expect(reconcileWallet).toHaveBeenCalledTimes(1)
  })

  it('a MessageBox that failed to open once is retried, never cached as dead', async () => {
    const box = messageBox()
    let attempt = 0
    const runtime = build({
      messageBox: async () => {
        attempt++
        if (attempt === 1) throw new Error('offline at launch')
        return box as never
      }
    })

    await runtime.reconcileJournals()
    expect(reconcileNotifications).not.toHaveBeenCalled()

    // A cached rejection would close the notification-retry window for the
    // whole process — for a fault that lasted one tick.
    await runtime.reconcileJournals()
    expect(reconcileNotifications).toHaveBeenCalledTimes(1)
    expect((reconcileNotifications as jest.Mock).mock.calls[0][0]).toBe(box)
  })

  it('does nothing at all on a chain this wallet has no Mandala for', async () => {
    await build({ chain: 'test', endpoints: undefined }).reconcileJournals()
    expect(reconcileWallet).not.toHaveBeenCalled()
    expect(reconcileNotifications).not.toHaveBeenCalled()
  })

  /**
   * THE 2026-09-15 CAUSE, pinned.
   *
   * `reconcileWallet`'s last step is a bulk sweep that aborts stuck `noSend`
   * mandala actions no journal entry claims. In this wallet every token request
   * is HELD by guard #2 for the settlement drain, so a live, admitted payment
   * looks exactly like an abandoned one — and on that day the sweep aborted a
   * transfer the overlay had broadcast 0.7 s earlier, releasing an input coin
   * that was already spent on chain. Settlement here is owned by
   * `token_settlements` and the drain over it; the sweep must never run.
   */
  it('NEVER lets the lib’s bulk sweep run — the wallet’s own drain owns settlement', async () => {
    await build().reconcileJournals()

    expect(reconcileWallet).toHaveBeenCalledTimes(1)
    expect((reconcileWallet as jest.Mock).mock.calls[0][1]).toEqual({ sweep: false, broadcast: false })
  })

  it('passes the opt-out on every pass, including the one the drain tick makes', async () => {
    const runtime = build()
    await runtime.drainNow()
    await runtime.reconcileJournals()

    expect((reconcileWallet as jest.Mock).mock.calls).toHaveLength(2)
    for (const call of (reconcileWallet as jest.Mock).mock.calls) {
      expect(call[1]).toEqual({ sweep: false, broadcast: false })
    }
  })
})

/**
 * THE 2026-09-15 REPAIR, over the fixture that reproduces the incident.
 *
 * A token transfer was admitted by the overlay — which broadcasts on admission
 * — and 0.7 s later the wallet aborted the still-`noSend` action that built it:
 * `proven_tx_reqs` `nosend → abortAction → invalid`, `transactions.status`
 * `failed`, and the input coin restored to spendable although it is spent on
 * chain. The settlement row still reads `admitted`. `repairAdmittedAborted`
 * is what puts the wallet's own view back — but ONLY on independent evidence
 * that the transaction is real, because the repair makes coins unspendable and
 * must never run on a guess.
 */
describe('repairAdmittedAborted — the wallet failed a transaction the chain has', () => {
  const REPAIR_TXID = '6597db42' + 'ab'.repeat(28)

  /** `tx failed + req invalid + settlement admitted`, exactly as the incident left it. */
  function damagedStorage(
    over: { txStatus?: string; reqStatus?: string } = {}
  ): { storage: StorageExpoSQLite; repair: jest.Mock } {
    const repair = jest.fn(async (txid: string) => ({
      txid,
      transactionIds: [41],
      wasTxStatuses: [over.txStatus ?? 'failed'],
      wasReqStatus: over.reqStatus ?? 'invalid',
      inputsMarkedSpent: 1,
      outputsMadeSpendable: 1,
      reqCreated: false
    }))
    return {
      storage: {
        sqliteDb: db,
        getKeyValue: async () => undefined,
        setKeyValue: async () => undefined,
        findTransactions: async () => [{ transactionId: 41, status: over.txStatus ?? 'failed' }],
        findProvenTxReqs: async () => [{ provenTxReqId: 9, txid: REPAIR_TXID, status: over.reqStatus ?? 'invalid' }],
        repairSettledTokenTransaction: repair
      } as unknown as StorageExpoSQLite,
      repair
    }
  }

  async function admittedRow(runtime: MandalaRuntime, state: 'admitted' | 'broadcast' = 'admitted'): Promise<void> {
    await runtime.store.upsertSettlement({
      txid: REPAIR_TXID,
      role: 'sent',
      assetId: ASSET_ID,
      state,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
  }

  /** The overlay still holding a verified σ_I for these bytes = it broadcast them. */
  function overlayStillHoldsIt(): void {
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: REPAIR_TXID,
      outputsToAdmit: [0],
      signature: signAdmission(REPAIR_TXID, [0]),
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })
  }

  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('repairs the transaction when the chain has it', async () => {
    const { storage, repair } = damagedStorage()
    const refetchBeef = jest.fn(async () => [1, 2, 3])
    const runtime = build({ storage, refetchBeef })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(1)
    expect(refetchBeef).toHaveBeenCalledWith(REPAIR_TXID)
    expect(repair).toHaveBeenCalledWith(REPAIR_TXID)
    // Says what it repaired, loudly: this is money bookkeeping, not debug noise.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(REPAIR_TXID))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('input(s) re-marked spent'))
  })

  it('repairs on the overlay’s own admission when the chain has not caught up', async () => {
    // The incident's own timing: the tx was broadcast SECONDS ago, so no
    // service will hand back a verifiable BEEF for it yet — and that is exactly
    // the window in which the coins are wrongly spendable.
    const { storage, repair } = damagedStorage()
    overlayStillHoldsIt()
    const runtime = build({ storage, refetchBeef: async () => undefined })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(1)
    expect(repair).toHaveBeenCalledWith(REPAIR_TXID)
  })

  it('repairs a `broadcast` row too — the same divergence, one state later', async () => {
    const { storage, repair } = damagedStorage()
    const runtime = build({ storage, refetchBeef: async () => [1] })
    await admittedRow(runtime, 'broadcast')

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(1)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('does NOTHING when neither the chain nor the overlay confirms the transaction', async () => {
    const { storage, repair } = damagedStorage()
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)
    const runtime = build({ storage, refetchBeef: async () => undefined })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(0)
    expect(repair).not.toHaveBeenCalled()
  })

  it('never acts on an unverifiable overlay answer — §9.10, the same anchor as everywhere else', async () => {
    const { storage, repair } = damagedStorage()
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid: REPAIR_TXID,
      outputsToAdmit: [0],
      signature: signAdmission(REPAIR_TXID, [0]),
      signerKey: new PrivateKey(321).toPublicKey().toString(),
      at: Date.now()
    })
    const runtime = build({ storage, refetchBeef: async () => undefined })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(0)
    expect(repair).not.toHaveBeenCalled()
  })

  it('leaves a healthy row alone — no chain lookup, no repair', async () => {
    const { storage, repair } = damagedStorage({ txStatus: 'unproven', reqStatus: 'unmined' })
    const refetchBeef = jest.fn(async () => [1])
    const runtime = build({ storage, refetchBeef })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(0)
    expect(refetchBeef).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
  })

  it('repairs a row whose request alone went invalid', async () => {
    const { storage, repair } = damagedStorage({ txStatus: 'unproven', reqStatus: 'invalid' })
    const runtime = build({ storage, refetchBeef: async () => [1] })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(1)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('never throws — a repair that cannot run is left for the next tick', async () => {
    const { storage } = damagedStorage()
    ;(storage as unknown as { repairSettledTokenTransaction: jest.Mock }).repairSettledTokenTransaction = jest.fn(
      async () => {
        throw new Error('database is locked')
      }
    )
    const runtime = build({ storage, refetchBeef: async () => [1] })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(0)
  })

  it('rides the drain tick, ahead of the release pass', async () => {
    const { storage, repair } = damagedStorage()
    const runtime = build({ storage, refetchBeef: async () => [1] })
    await admittedRow(runtime)

    await runtime.drainNow()
    expect(repair).toHaveBeenCalledWith(REPAIR_TXID)
  })

  it('does nothing on a chain this wallet has no Mandala for', async () => {
    const { storage, repair } = damagedStorage()
    const runtime = build({ storage, chain: 'test', endpoints: undefined })
    await admittedRow(runtime)

    await expect(runtime.repairAdmittedAborted()).resolves.toBe(0)
    expect(repair).not.toHaveBeenCalled()
  })
})

// ───────────── the two figures the holder actually reads ─────────────

describe('settled money is not "settling" money', () => {
  it('an admitted row is settled — σ_I is the issuer folding it in, the broadcast is bookkeeping', async () => {
    const runtime = build()
    for (const [txid, state, amount] of [
      ['a1'.repeat(32), 'admitted', 40],
      ['a2'.repeat(32), 'broadcast', 11],
      ['a3'.repeat(32), 'held', 7]
    ] as const) {
      await runtime.store.upsertSettlement({
        txid,
        role: 'received',
        assetId: ASSET_ID,
        state,
        amountBaseUnits: amount,
        overlayUrl: ENDPOINTS.overlayUrl,
        overlayIdentityKey: OVERLAY_KEY
      })
    }

    const mine = (await runtime.balances()).find(x => x.asset.assetId === ASSET_ID)
    expect(mine?.unsettledBaseUnits).toBe(7)
  })

  it('reports a committed send whose recipient notification has not gone out yet', async () => {
    const txid = '45'.repeat(32)
    ;(transferTokens as jest.Mock).mockResolvedValue({ txid, notified: false })
    const runtime = build()

    expect(await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 5 })).toEqual({
      kind: 'sent',
      txid,
      settled: false,
      notified: false
    })
    // Committed all the same: the row exists and the drain owns it.
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
  })
})

// ───────────── the asset-status cache expires while somebody is watching ─────────────

describe('the assetStatus cache is stamped at LOAD time', () => {
  it('a cache hit does not refresh its own timestamp', async () => {
    let ms = Date.parse('2026-09-15T12:00:00.000Z')
    const runtime = build({ now: () => new Date(ms) })

    await runtime.assetStatus(ASSET_ID)
    expect(resolveAssetState).toHaveBeenCalledTimes(1)

    // A screen polling faster than the TTL: still a hit, and it must not push
    // the expiry out — otherwise a paused or frozen asset never surfaces for
    // exactly the user who is looking at it.
    ms += 6_000
    await runtime.assetStatus(ASSET_ID)
    expect(resolveAssetState).toHaveBeenCalledTimes(1)

    ms += 6_000 // 12s since the LOAD, 6s since the last read
    await runtime.assetStatus(ASSET_ID)
    expect(resolveAssetState).toHaveBeenCalledTimes(2)
  })
})

// ───────── settleNow: the payer’s own submit, once the hand-over lands ─────────

/**
 * The 2026-09-15 refinement, which is entirely about ORDER.
 *
 * Hand-over first is unchanged and untouchable: the payee is handed the bytes
 * before a single request goes to the overlay, and nothing about the overlay
 * may turn a completed hand-over into a failed send. What changes is what
 * happens in the second after that — an online payer finishes their own
 * submit-then-broadcast immediately instead of waiting for a drain tick.
 *
 * So every test here asserts a sequence, not just an outcome.
 */
describe('settleNow — one row, settled immediately, hand-over first', () => {
  /** The facilitator frames off-chain values as `varint(len) ‖ beef ‖ values`. */
  const txidOfFramedBody = (init: unknown): string => {
    const { headers, body } = init as { headers?: Record<string, string>; body: Uint8Array }
    if (headers?.['x-includes-off-chain-values'] !== 'true') return txidOfSubmitBody(init)
    const reader = new Utils.Reader(Array.from(body))
    const length = reader.readVarIntNum()
    const beef = Beef.fromBinary(reader.read(length))
    return beef.atomicTxid ?? beef.txs[beef.txs.length - 1].txid
  }

  /** Every `/submit` answers admitted, with a real σ_I over the body's own txid. */
  const admitting =
    (posted: string[], order?: string[]) =>
    async (_url: unknown, init: unknown) => {
      order?.push('submit')
      const txid = txidOfFramedBody(init)
      posted.push(txid)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            tm_mandala: {
              outputsToAdmit: [0],
              admissionSignature: signAdmission(txid, [0]),
              admissionIdentityKey: OVERLAY_KEY
            }
          })
      }
    }

  /**
   * A tip this wallet owns, and the `transferTokens` answer that hands it over.
   * Pushing `'post'` is what makes the MessageBox post's position in the
   * sequence observable — the lib pipeline itself is mocked.
   */
  function handOver(order?: string[], over: { notified?: boolean } = {}) {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(tip)
    ;(transferTokens as jest.Mock).mockImplementation(async () => {
      order?.push('post')
      return {
        txid,
        notified: over.notified ?? true,
        handedOver: true,
        atomicBeef: beef.toBinaryAtomic(txid),
        offChainValues: [4, 5, 6]
      }
    })
    return { tip, txid, req: { txid, rawTx: tip.toBinary() } }
  }

  it('online: posts the v2 body FIRST, then submits its own bytes and broadcasts', async () => {
    const order: string[] = []
    const { txid, req } = handOver(order)
    const posted: string[] = []
    const broadcasts: string[] = []
    const runtime = build(
      {
        fetchImpl: admitting(posted, order) as never,
        isOnline: async () => true,
        broadcast: async (id: string) => {
          order.push('broadcast')
          broadcasts.push(id)
          return 'success'
        }
      },
      [],
      [req]
    )

    const result = await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })

    expect(result).toEqual({ kind: 'sent', txid, settled: true, notified: true })
    // The whole of the decision, in one assertion: the payee has the bytes
    // before the overlay is asked anything, and the broadcast is last.
    expect(order).toEqual(['post', 'submit', 'broadcast'])
    expect(posted).toEqual([txid])
    expect(broadcasts).toEqual([txid])
    expect((await runtime.store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('offline: the hand-over stands alone — nothing is submitted and nothing is claimed', async () => {
    const { txid, req } = handOver()
    const fetchImpl = jest.fn(async () => {
      throw new Error('an offline send must never reach the overlay')
    })
    const broadcast = jest.fn(async () => 'success' as const)
    const runtime = build({ fetchImpl: fetchImpl as never, isOnline: async () => false, broadcast }, [], [req])

    expect(await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })).toEqual({
      kind: 'sent',
      txid,
      settled: false,
      notified: true
    })
    // Not "it failed quietly" — it was never attempted, and the row is exactly
    // what the drain expects to find on the next online tick.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
  })

  it('an unreachable overlay still leaves the send successful, with the row handed_over', async () => {
    const { txid, req } = handOver()
    const broadcast = jest.fn(async () => 'success' as const)
    const runtime = build(
      {
        fetchImpl: (async () => {
          throw new Error('Network request failed')
        }) as never,
        isOnline: async () => true,
        broadcast
      },
      [],
      [req]
    )

    expect(await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })).toEqual({
      kind: 'sent',
      txid,
      settled: false,
      notified: true
    })
    // A liftable fault never burns a row, and never reaches a broadcast.
    expect(broadcast).not.toHaveBeenCalled()
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
  })

  it('a notification that did not go out is not a hand-over, so nothing is submitted', async () => {
    const { txid, req } = handOver(undefined, { notified: false })
    const fetchImpl = jest.fn(async () => {
      throw new Error('the payee has not been handed anything yet')
    })
    const runtime = build({ fetchImpl: fetchImpl as never, isOnline: async () => true }, [], [req])

    expect(await runtime.sendToHandle({ assetId: ASSET_ID, recipientIdentityKey: PAYEE, baseUnits: 40 })).toEqual({
      kind: 'sent',
      txid,
      settled: false,
      notified: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await runtime.store.getSettlement(txid))?.state).toBe('handed_over')
  })

  it('coalesces concurrent calls for the same txid onto one submit and one broadcast', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const posted: string[] = []
    const broadcasts: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const runtime = build(
      {
        // Held open until both calls are in flight, so the second one has no
        // choice but to join the first rather than start its own.
        fetchImpl: (async (url: unknown, init: unknown) => {
          await gate
          return await admitting(posted)(url, init)
        }) as never,
        broadcast: async (id: string) => {
          broadcasts.push(id)
          return 'success'
        }
      },
      [],
      [{ txid, rawTx: tip.toBinary() }]
    )
    await runtime.store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'handed_over',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })

    const first = runtime.settleNow(txid)
    const second = runtime.settleNow(txid)
    release?.()

    expect(await first).toBe('broadcast')
    expect(await second).toBe('broadcast')
    expect(posted).toEqual([txid])
    expect(broadcasts).toEqual([txid])

    // …and the guard is per-txid and per-run, not a permanent one: a later call
    // for a row that is now terminal simply reports it.
    expect(await runtime.settleNow(txid)).toBe('broadcast')
    expect(posted).toEqual([txid])
  })

  it('never claims a row the USER owns, and never invents one', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('a parked payment is not the drain’s to settle (FIX F)')
    })
    const runtime = build({ fetchImpl: fetchImpl as never })
    const parked = '5a'.repeat(32)
    await runtime.store.upsertSettlement({
      txid: parked,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'parked',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })

    expect(await runtime.settleNow(parked)).toBe('parked')
    expect(await runtime.settleNow('5b'.repeat(32))).toBe('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is unavailable, never a throw, on a chain with no Mandala deployment', async () => {
    await expect(build({ endpoints: undefined }).settleNow('5c'.repeat(32))).resolves.toBe('unavailable')
  })
})

/**
 * The txid the facilitator's body names. The body is `varint(len) ‖ beef` when
 * off-chain values ride along, and bare AtomicBEEF otherwise; both end in the
 * subject transaction, so parsing the AtomicBEEF back is the honest read.
 */
function txidOfSubmitBody(init: unknown): string {
  const body = (init as { body: Uint8Array }).body
  const beef = Beef.fromBinary(Array.from(body))
  return beef.atomicTxid ?? beef.txs[beef.txs.length - 1].txid
}


// ───────── 2026-09-15 incident: the fee input the walk could not see ─────────

describe('cover completes the tip’s ancestry from the wallet before walking', () => {
  it('a plain-BSV fee parent that is not in inputBEEF is fetched, not read as a hole', async () => {
    // 8045794f: token inputs from an admitted parent (in inputBEEF), plus a fee
    // input from UNMINED change of an earlier BSV send that the noSend action's
    // stored inputBEEF never carried. FIX B made that invisible parent a hole
    // and the immediate submit silently never happened.
    const tokenParent = rootTx(100)
    const feeParent = new Transaction()
    feeParent.addOutput({ satoshis: 600, lockingScript: LockingScript.fromHex('51') })
    const tip = txSpending([{ tx: tokenParent, vout: 0 }])
    tip.addInput({ sourceTransaction: feeParent, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
    const tipTxid = tip.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(tokenParent)

    const storage = fakeStorage(db, [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBEEF.toBinary() }], [feeParent])
    const runtime = build({ storage })
    await runtime.store.putAdmission({
      txid: tokenParent.id('hex'),
      outputsToAdmit: [0],
      signatureHex: signAdmission(tokenParent.id('hex'), [0]),
      signerKey: OVERLAY_KEY,
      source: 'fetched',
      obtainedAt: new Date().toISOString()
    })
    expect(await runtime.cover(tipTxid)).toEqual({ ok: true, mustSubmit: [tipTxid] })
  })

  it('a parent the wallet cannot produce either is still a hole', async () => {
    const tokenParent = rootTx(100)
    const feeParent = new Transaction()
    feeParent.addOutput({ satoshis: 600, lockingScript: LockingScript.fromHex('51') })
    const tip = txSpending([{ tx: tokenParent, vout: 0 }])
    tip.addInput({ sourceTransaction: feeParent, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
    const tipTxid = tip.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(tokenParent)
    const runtime = build({ storage: fakeStorage(db, [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBEEF.toBinary() }]) })
    expect(await runtime.cover(tipTxid)).toEqual({ ok: false, reason: 'uncovered_ancestor' })
  })
})

describe('settlePendingSends — the handle rail’s rows are driven on every tick', () => {
  const admitting = (posted: string[]) => async (_url: unknown, init: unknown) => {
    const { headers, body } = init as { headers?: Record<string, string>; body: Uint8Array }
    let txid: string
    if (headers?.['x-includes-off-chain-values'] === 'true') {
      const reader = new Utils.Reader(Array.from(body))
      const beef = Beef.fromBinary(reader.read(reader.readVarIntNum()))
      txid = beef.atomicTxid ?? beef.txs[beef.txs.length - 1].txid
    } else txid = txidOfSubmitBody(init)
    posted.push(txid)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          tm_mandala: { outputsToAdmit: [0], admissionSignature: signAdmission(txid, [0]), admissionIdentityKey: OVERLAY_KEY }
        })
    }
  }

  async function handedOverRow(runtime: MandalaRuntime, txid: string, state: 'handed_over' | 'admitted' = 'handed_over') {
    await runtime.store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: ASSET_ID,
      state,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      amountBaseUnits: 40
    })
  }

  it('a handed_over row with no queue entry is submitted and broadcast by the tick', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const posted: string[] = []
    const broadcasts: string[] = []
    const runtime = build(
      { fetchImpl: admitting(posted) as never, broadcast: async (id: string) => { broadcasts.push(id); return 'success' } },
      [],
      [{ txid, rawTx: tip.toBinary(), status: 'nosend' }]
    )
    await handedOverRow(runtime, txid)
    await runtime.store.putLinkage({ txid, payloadBytes: Uint8Array.from([1]), overlayUrl: ENDPOINTS.overlayUrl, overlayIdentityKey: OVERLAY_KEY, source: 'minted', createdAt: new Date().toISOString() })

    expect(await runtime.settlePendingSends()).toBe(1)
    expect(posted).toEqual([txid])
    expect(broadcasts).toEqual([txid])
    expect((await runtime.store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('an admitted row whose request the network already has is closed as broadcast without a submit', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const posted: string[] = []
    const broadcasts: string[] = []
    const runtime = build(
      { fetchImpl: admitting(posted) as never, broadcast: async (id: string) => { broadcasts.push(id); return 'success' } },
      [],
      [{ txid, rawTx: tip.toBinary(), status: 'completed' }]
    )
    await handedOverRow(runtime, txid, 'admitted')
    await runtime.store.putAdmission({ txid, outputsToAdmit: [0], signatureHex: signAdmission(txid, [0]), signerKey: OVERLAY_KEY, source: 'fetched', obtainedAt: new Date().toISOString() })
    expect(await runtime.settlePendingSends()).toBe(1)
    expect(posted).toEqual([])
    // The cached σ_I stands in for the submit; the broadcast step runs, and in
    // production `postOwnedByTxid` answers from the recorded request status
    // ('completed' ⇒ success) without touching the network.
    expect(broadcasts).toEqual([txid])
    expect((await runtime.store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('leaves built/parked rows and received rows alone', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const posted: string[] = []
    const runtime = build({ fetchImpl: admitting(posted) as never }, [], [{ txid, rawTx: tip.toBinary(), status: 'nosend' }])
    await runtime.store.upsertSettlement({ txid, role: 'sent', assetId: ASSET_ID, state: 'parked', overlayUrl: ENDPOINTS.overlayUrl, overlayIdentityKey: OVERLAY_KEY })
    expect(await runtime.settlePendingSends()).toBe(0)
    expect(posted).toEqual([])
    expect((await runtime.store.getSettlement(txid))?.state).toBe('parked')
  })
})

describe('submit completes the tip’s ancestry from the wallet before posting', () => {
  it('the posted BEEF carries a fee parent that inputBEEF did not', async () => {
    const tokenParent = rootTx(100)
    const feeParent = new Transaction()
    feeParent.addOutput({ satoshis: 600, lockingScript: LockingScript.fromHex('51') })
    const tip = txSpending([{ tx: tokenParent, vout: 0 }])
    tip.addInput({ sourceTransaction: feeParent, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
    const tipTxid = tip.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(tokenParent)

    let postedBeef: Beef | undefined
    const fetchImpl = async (_url: unknown, init: unknown) => {
      const { body } = init as { body: Uint8Array }
      postedBeef = Beef.fromBinary(Array.from(body))
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            tm_mandala: { outputsToAdmit: [0], admissionSignature: signAdmission(tipTxid, [0]), admissionIdentityKey: OVERLAY_KEY }
          })
      }
    }
    const storage = fakeStorage(db, [{ txid: tipTxid, rawTx: tip.toBinary(), inputBEEF: inputBEEF.toBinary() }], [feeParent])
    const runtime = build({ storage, fetchImpl: fetchImpl as never })
    const verdict = await runtime.tokenDeps.submit(tipTxid)
    expect(verdict.kind).toBe('admitted')
    expect(postedBeef?.findTxid(feeParent.id('hex'))?.tx).toBeDefined()
    expect(postedBeef?.findTxid(tokenParent.id('hex'))?.tx).toBeDefined()
  })
})

describe('ensureAdmissionsForHoldings — every held coin carries a verified σ_I', () => {
  it('fetches and caches the admission of a coin that has none, and skips coins that do', async () => {
    const admittedTx = rootTx(10)
    const bareTx = rootTx(20)
    const runtime = build({}, [
      { tx: admittedTx, vout: 0 },
      { tx: bareTx, vout: 0 }
    ])
    await runtime.store.putAdmission({ txid: admittedTx.id('hex'), outputsToAdmit: [0], signatureHex: signAdmission(admittedTx.id('hex'), [0]), signerKey: OVERLAY_KEY, source: 'submitted', obtainedAt: new Date().toISOString() })
    ;(libFetchAdmission as jest.Mock).mockImplementation(async (_url: string, txid: string) => ({
      kind: 'admitted',
      txid,
      outputsToAdmit: [0],
      signature: signAdmission(txid, [0]),
      signerKey: OVERLAY_KEY,
      at: Date.now()
    }))
    expect(await runtime.ensureAdmissionsForHoldings()).toBe(1)
    expect((libFetchAdmission as jest.Mock).mock.calls.map(c => c[1])).toEqual([bareTx.id('hex')])
    expect((await runtime.store.getAdmission(bareTx.id('hex')))).toMatchObject({ signerKey: OVERLAY_KEY, source: 'fetched' })
  })

  it('never caches an answer that does not verify under the configured key', async () => {
    const bareTx = rootTx(20)
    const runtime = build({}, [{ tx: bareTx, vout: 0 }])
    const impostor = PrivateKey.fromRandom()
    ;(libFetchAdmission as jest.Mock).mockImplementation(async (_url: string, txid: string) => ({
      kind: 'admitted',
      txid,
      outputsToAdmit: [0],
      signature: impostor.sign(Utils.toArray(admissionMessageV2(txid, [0]), 'utf8')).toDER('hex'),
      signerKey: impostor.toPublicKey().toString(),
      at: Date.now()
    }))
    expect(await runtime.ensureAdmissionsForHoldings()).toBe(0)
    expect(await runtime.store.getAdmission(bareTx.id('hex'))).toBeUndefined()
  })
})


describe('reviewTokenHoldings — Check Wallet asks the overlay about every settling row and held coin', () => {
  const SENT_TXID = '77'.repeat(32)

  function checkStorage(reqs: FakeReq[] = [], outputs: { outputId: number; txid: string; vout: number }[] = []) {
    const updateTransactionStatus = jest.fn(async () => undefined)
    const updateOutput = jest.fn(async () => 1)
    const storage = {
      ...(fakeStorage(db, reqs) as unknown as Record<string, unknown>),
      findTransactions: async ({ partial }: { partial: { txid?: string } }) =>
        partial.txid === SENT_TXID || outputs.some(o => o.txid === partial.txid)
          ? [{ transactionId: 41, txid: partial.txid, status: 'nosend' }]
          : [],
      findOutputs: async ({ partial }: { partial: { txid?: string; vout?: number } }) =>
        outputs.filter(o => o.txid === partial.txid && (partial.vout === undefined || o.vout === partial.vout)),
      updateTransactionStatus,
      updateOutput
    } as unknown as StorageExpoSQLite
    return { storage, updateTransactionStatus, updateOutput }
  }

  async function sentRow(runtime: MandalaRuntime, state: 'handed_over' | 'built' = 'handed_over') {
    await runtime.store.upsertSettlement({
      txid: SENT_TXID,
      role: 'sent',
      assetId: ASSET_ID,
      state,
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY,
      amountBaseUnits: 40
    })
  }

  it('a settling row the overlay refused is closed as refused and its transaction failed', async () => {
    const { storage, updateTransactionStatus } = checkStorage()
    const runtime = build({ storage })
    await sentRow(runtime)
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({ kind: 'refused', code: 'ERR_INPUT_SPENT' })

    const r = await runtime.reviewTokenHoldings()
    expect(r).toEqual({ settled: 0, removed: 1, unattested: 0, unreachable: false })
    expect((await runtime.store.getSettlement(SENT_TXID))?.state).toBe('refused')
    expect((await runtime.store.getSettlement(SENT_TXID))?.refusedCode).toBe('ERR_INPUT_SPENT')
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 41)
  })

  it('an evicted row is closed as orphaned', async () => {
    const { storage, updateTransactionStatus } = checkStorage()
    const runtime = build({ storage })
    await sentRow(runtime)
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({ kind: 'evicted' })

    expect((await runtime.reviewTokenHoldings()).removed).toBe(1)
    expect((await runtime.store.getSettlement(SENT_TXID))?.state).toBe('orphaned')
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 41)
  })

  it('a row the overlay has never heard of is reported, never removed', async () => {
    const { storage, updateTransactionStatus } = checkStorage()
    const runtime = build({ storage })
    await sentRow(runtime)
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)

    const r = await runtime.reviewTokenHoldings()
    expect(r).toEqual({ settled: 0, removed: 0, unattested: 1, unreachable: false })
    expect((await runtime.store.getSettlement(SENT_TXID))?.state).toBe('handed_over')
    expect(updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('an unreachable overlay writes nothing and says so', async () => {
    const { storage, updateTransactionStatus } = checkStorage()
    const runtime = build({ storage })
    await sentRow(runtime)
    ;(libFetchAdmission as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))

    const r = await runtime.reviewTokenHoldings()
    expect(r.unreachable).toBe(true)
    expect(r.removed).toBe(0)
    expect(updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('never touches a built/parked row — the user owns those', async () => {
    const { storage } = checkStorage()
    const runtime = build({ storage })
    await sentRow(runtime, 'built')
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({ kind: 'refused', code: 'ERR_X' })

    expect(await runtime.reviewTokenHoldings()).toEqual({ settled: 0, removed: 0, unattested: 0, unreachable: false })
    expect(libFetchAdmission).not.toHaveBeenCalled()
  })

  it('a row whose step settles now counts as settled', async () => {
    const tip = rootTx(40)
    const txid = tip.id('hex')
    const { storage } = checkStorage([{ txid, rawTx: tip.toBinary(), status: 'completed' }])
    const runtime = build({ storage, broadcast: async () => 'success' })
    await runtime.store.upsertSettlement({
      txid,
      role: 'sent',
      assetId: ASSET_ID,
      state: 'admitted',
      overlayUrl: ENDPOINTS.overlayUrl,
      overlayIdentityKey: OVERLAY_KEY
    })
    await runtime.store.putAdmission({
      txid,
      outputsToAdmit: [0],
      signatureHex: signAdmission(txid, [0]),
      signerKey: OVERLAY_KEY,
      source: 'fetched',
      obtainedAt: new Date().toISOString()
    })

    expect((await runtime.reviewTokenHoldings()).settled).toBe(1)
    expect((await runtime.store.getSettlement(txid))?.state).toBe('broadcast')
  })

  it('a held coin the overlay admitted for a DIFFERENT output is made unspendable', async () => {
    const coin = rootTx(100)
    const txid = coin.id('hex')
    const { storage, updateOutput, updateTransactionStatus } = checkStorage([], [{ outputId: 7, txid, vout: 0 }])
    const runtime = build({ storage }, [{ tx: coin, vout: 0 }])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid,
      outputsToAdmit: [1],
      signature: signAdmission(txid, [1]),
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })

    expect((await runtime.reviewTokenHoldings()).removed).toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(7, { spendable: false })
    expect(updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('a held coin whose transaction the overlay refused has that transaction failed', async () => {
    const coin = rootTx(100)
    const txid = coin.id('hex')
    const { storage, updateTransactionStatus } = checkStorage([], [{ outputId: 7, txid, vout: 0 }])
    const runtime = build({ storage }, [{ tx: coin, vout: 0 }])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({ kind: 'refused', code: 'ERR_INPUT_SPENT' })

    expect((await runtime.reviewTokenHoldings()).removed).toBe(1)
    expect(updateTransactionStatus).toHaveBeenCalledWith('failed', 41)
  })

  it('a held coin with a verified admission covering it needs no lookup', async () => {
    const coin = rootTx(100)
    const txid = coin.id('hex')
    const { storage, updateOutput } = checkStorage([], [{ outputId: 7, txid, vout: 0 }])
    const runtime = build({ storage }, [{ tx: coin, vout: 0 }])
    await runtime.store.putAdmission({
      txid,
      outputsToAdmit: [0],
      signatureHex: signAdmission(txid, [0]),
      signerKey: OVERLAY_KEY,
      source: 'fetched',
      obtainedAt: new Date().toISOString()
    })

    expect(await runtime.reviewTokenHoldings()).toEqual({ settled: 0, removed: 0, unattested: 0, unreachable: false })
    expect(libFetchAdmission).not.toHaveBeenCalled()
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('a held coin the overlay does not know is reported as unattested and kept', async () => {
    const coin = rootTx(100)
    const txid = coin.id('hex')
    const { storage, updateOutput } = checkStorage([], [{ outputId: 7, txid, vout: 0 }])
    const runtime = build({ storage }, [{ tx: coin, vout: 0 }])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue(undefined)

    expect((await runtime.reviewTokenHoldings()).unattested).toBe(1)
    expect(updateOutput).not.toHaveBeenCalled()
  })

  it('a held coin the overlay admits is cached, like ensureAdmissionsForHoldings', async () => {
    const coin = rootTx(100)
    const txid = coin.id('hex')
    const { storage } = checkStorage([], [{ outputId: 7, txid, vout: 0 }])
    const runtime = build({ storage }, [{ tx: coin, vout: 0 }])
    ;(libFetchAdmission as jest.Mock).mockResolvedValue({
      kind: 'admitted',
      txid,
      outputsToAdmit: [0],
      signature: signAdmission(txid, [0]),
      signerKey: OVERLAY_KEY,
      at: Date.now()
    })

    expect(await runtime.reviewTokenHoldings()).toEqual({ settled: 0, removed: 0, unattested: 0, unreachable: false })
    expect((await runtime.store.getAdmission(txid))?.source).toBe('fetched')
  })

  it('does nothing on a chain with no Mandala', async () => {
    const { storage } = checkStorage()
    const runtime = build({ storage, chain: 'test', endpoints: undefined })
    expect(await runtime.reviewTokenHoldings()).toEqual({ settled: 0, removed: 0, unattested: 0, unreachable: false })
  })
})
