/**
 * Host settlement of token hand-overs and receipts (plan 07 Task 12, design
 * §9 B7). The module settles nothing; the runtime does, with the lib:
 *
 *  · a delivered own hand-over (`handed_over`, `delivered`) goes through lib
 *    `settleHandover` with the exact bytes and envelope the host ledger
 *    recorded at send time; a held receipt through `settleReceipts`.
 *  · The `markSettled` handed to the lib is the module's flag FIRST, then the
 *    journal row, so the lib's post-admission broadcast already finds the row
 *    `settled` (the hold releases it).
 *  · Nothing is submitted for a row the payer withheld (`built`/`parked`), an
 *    undelivered hand-over (B5) or a row already final. A refused own
 *    hand-over is journaled `refused` BEFORE its action is aborted, once.
 *  · `isHandoverAdmitted` answers `undefined` whenever the overlay cannot be
 *    asked or answers something it cannot read, and `false` only on an empty
 *    output list.
 *  · `reconcileHeld` journals an unjournaled receipt as `held` whenever any of
 *    its records is `color_offline` (never `settled`).
 *
 * The journal is real SQLite and the host ledger the lib's own: the CAS and
 * INSERT OR IGNORE are what the concurrency pins prove. The lib's overlay
 * calls (`settleHandover`, `settleReceipts`) are the seams under test.
 */
jest.mock('@bsv/mandala', () => {
  const actual = jest.requireActual('@bsv/mandala')
  return { ...actual, settleHandover: jest.fn(), settleReceipts: jest.fn() }
})

import type { DatabaseSync } from 'node:sqlite'
import { Hash, LockingScript, PrivateKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import type { ColorOverlayProvider } from '@bsv/color-permission-module'
import {
  createHostLedger,
  settleHandover,
  settleReceipts,
  type HostLedger,
  type ReceiptSettleResult,
  type SettleResult
} from '@bsv/mandala'
import { createSettler, readHandoverAdmission, type SettleDeps } from '../../core/mandala/settle'
import { createMandalaRuntime, type CreateMandalaRuntimeArgs } from '../../core/mandala/createRuntime'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import type { ColorTransferRow } from '../../core/mandala/types'
import type { InventoryRecord } from '../../core/mandala/assets'
import { openTestDb, type ExpoLikeDb } from '../__helpers__/nodeSqlite'

const settleHandoverMock = settleHandover as jest.MockedFunction<typeof settleHandover>
const settleReceiptsMock = settleReceipts as jest.MockedFunction<typeof settleReceipts>

const ADMIN = 'admin.example'
const T = 'a1'.repeat(32)
const U = 'b2'.repeat(32)
const A = `${'ab'.repeat(32)}_0`
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}
const MAX_U64 = 18446744073709551615n
const BEEF_HEX = '0101010100'
const ENVELOPE_HEX = '7b7d'
const SIGMA = { txid: T, outputs: [1], signer: EP.overlayIdentityKey, signature: '3006' }

let raw: DatabaseSync
let db: ExpoLikeDb
let journal: TransferJournal
let ledger: HostLedger
let storage: CreateMandalaRuntimeArgs['storage']

beforeEach(async () => {
  let kv: { getKeyValue(k: string): Promise<string | undefined>; setKeyValue(k: string, v: string): Promise<void> }
  ;({ raw, db, kv } = await openTestDb())
  journal = createTransferJournal(db as JournalDb, () => new Date(NOW))
  storage = { getKeyValue: kv.getKeyValue, setKeyValue: kv.setKeyValue, sqliteDb: db } as never
  const mem = new Map<string, string>()
  ledger = createHostLedger({
    getItem: async k => mem.get(k) ?? null,
    setItem: async (k, v) => {
      mem.set(k, v)
    },
    removeItem: async k => {
      mem.delete(k)
    },
    keys: async prefix => [...mem.keys()].filter(k => k.startsWith(prefix))
  })
  settleHandoverMock.mockReset()
  settleReceiptsMock.mockReset()
  settleReceiptsMock.mockResolvedValue([])
})

afterEach(() => raw.close())

const tick = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve))
}

function row(over: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    txid: T,
    role: 'sent' as const,
    assetId: A,
    units: 1500n,
    outputIndex: 0,
    rail: 'handle' as const,
    state: 'handed_over' as const,
    delivered: true,
    reference: 'ref-T',
    ...over
  }
}

/** The own `pending` record `sendHandover` writes at signing. */
async function ownPending(txid = T): Promise<void> {
  await ledger.put({
    v: 1,
    txid,
    assetId: A,
    state: 'pending',
    own: true,
    outputs: [1],
    beefHex: BEEF_HEX,
    submits: [{ txid, beefHex: BEEF_HEX, offChainHex: ENVELOPE_HEX }],
    at: 1
  })
}

/** A settleHandover that, like the lib, runs markSettled before it resolves admitted. */
function admits(): jest.MockedFunction<typeof settleHandover> {
  return settleHandoverMock.mockImplementation(async p => {
    await p.markSettled?.(p.handover.txid)
    return { status: 'admitted', attestation: SIGMA } as SettleResult
  })
}

function deps(o: { abort?: SettleDeps['abort']; onChange?: () => void; markSettled?: SettleDeps['markSettled'] } = {}) {
  return {
    wallet: { abortAction: jest.fn() } as unknown as WalletInterface,
    journal,
    ledger,
    markSettled: o.markSettled ?? jest.fn(async (_t: string) => {}),
    overlayIdentityKey: EP.overlayIdentityKey,
    abort: o.abort ?? jest.fn(async (_r: string) => ({ aborted: true })),
    onChange: o.onChange ?? jest.fn()
  }
}

describe('settleNow: an own hand-over', () => {
  it('submits the exact ledger bytes once for concurrent calls, and settles through markSettled', async () => {
    await journal.insert(row())
    await ownPending()
    const d = deps()
    let stateAtMark: string | undefined
    settleHandoverMock.mockImplementation(async p => {
      await tick()
      await p.markSettled?.(p.handover.txid)
      stateAtMark = (await journal.get(T))?.state
      return { status: 'admitted', attestation: SIGMA }
    })
    const s = createSettler(d)
    const [a, b] = await Promise.all([s.settleNow(T), s.settleNow(T)])
    expect([a, b]).toEqual(['settled', 'settled'])
    expect(settleHandoverMock).toHaveBeenCalledTimes(1)
    expect(settleHandoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: d.wallet,
        handover: { txid: T, tx: Utils.toArray(BEEF_HEX, 'hex'), offChainValues: Utils.toArray(ENVELOPE_HEX, 'hex') },
        assetId: A,
        overlayIdentityKey: EP.overlayIdentityKey,
        ledger
      })
    )
    // The module flag first, and the row already settled before the lib's
    // post-admission broadcast would start.
    expect(d.markSettled).toHaveBeenCalledWith(T)
    expect(stateAtMark).toBe('settled')
    expect(d.onChange).toHaveBeenCalled()
  })

  it('never submits a built, parked or undelivered hand-over (FIX F, B5)', async () => {
    for (const [txid, over] of [
      ['01'.repeat(32), { state: 'built' as const, delivered: false }],
      ['02'.repeat(32), { state: 'parked' as const, delivered: false }],
      ['03'.repeat(32), { state: 'handed_over' as const, delivered: false }]
    ] as const) {
      await journal.insert(row({ txid, ...over }))
      await ownPending(txid)
      expect(await createSettler(deps()).settleNow(txid)).toBe(over.state)
    }
    expect(settleHandoverMock).not.toHaveBeenCalled()
  })

  it('names neither a final row nor an unknown txid to the lib', async () => {
    await journal.insert(row({ state: 'settled' }))
    await journal.insert(row({ txid: U, state: 'cancelled', delivered: false }))
    const s = createSettler(deps())
    expect(await s.settleNow(T)).toBe('settled')
    expect(await s.settleNow(U)).toBe('cancelled')
    expect(await s.settleNow('c3'.repeat(32))).toBe('unavailable')
    expect(settleHandoverMock).not.toHaveBeenCalled()
    expect(settleReceiptsMock).not.toHaveBeenCalled()
  })

  it('a refused hand-over is journaled refused with its code, then aborted once', async () => {
    await journal.insert(row())
    await ownPending()
    const order: string[] = []
    const abort = jest.fn(async (reference: string) => {
      order.push(`abort:${(await journal.get(T))!.state}`)
      return { aborted: reference === 'ref-T' }
    })
    settleHandoverMock.mockResolvedValue({ status: 'refused', code: 'ERR_CONSERVATION' })
    const s = createSettler(deps({ abort }))
    expect(await s.settleNow(T)).toBe('refused')
    expect((await journal.get(T))!.code).toBe('ERR_CONSERVATION')
    expect(order).toEqual(['abort:refused'])
    // A later settleNow of the refused row retries nothing it already released.
    expect(await s.settleNow(T)).toBe('refused')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(settleHandoverMock).toHaveBeenCalledTimes(1)
  })

  it('retries the abort of a refused row whose abort failed, without asking the lib', async () => {
    await journal.insert(row({ state: 'refused' }))
    const abort = jest.fn(async () => ({ aborted: false }))
    const s = createSettler(deps({ abort }))
    expect(await s.settleNow(T)).toBe('refused')
    expect(await s.settleNow(T)).toBe('refused')
    expect(abort).toHaveBeenCalledTimes(2)
    expect(settleHandoverMock).not.toHaveBeenCalled()
  })

  it('a retry verdict changes nothing; a thrown settle reports the current state', async () => {
    await journal.insert(row())
    await ownPending()
    settleHandoverMock.mockResolvedValueOnce({ status: 'retry', code: 'ERR_UNAVAILABLE' })
    const s = createSettler(deps())
    expect(await s.settleNow(T)).toBe('handed_over')
    settleHandoverMock.mockRejectedValueOnce(new Error('OVERLAY_URL_UNSET'))
    expect(await s.settleNow(T)).toBe('handed_over')
  })

  it('finishes a hand-over the ledger already holds settled, without submitting', async () => {
    await journal.insert(row())
    await ledger.put({
      v: 1,
      txid: T,
      assetId: A,
      state: 'settled',
      own: true,
      outputs: [],
      attestation: SIGMA,
      marked: false,
      at: 2
    })
    const d = deps()
    expect(await createSettler(d).settleNow(T)).toBe('settled')
    expect(d.markSettled).toHaveBeenCalledWith(T)
    expect(settleHandoverMock).not.toHaveBeenCalled()
  })

  it('keeps a hand-over with no ledger submit bytes where it is', async () => {
    await journal.insert(row())
    expect(await createSettler(deps()).settleNow(T)).toBe('handed_over')
    expect(settleHandoverMock).not.toHaveBeenCalled()
  })

  it('an unreadable journal is unavailable, never a verdict', async () => {
    const broken = {
      ...journal,
      get: async () => {
        throw new Error('SQLITE_BUSY')
      }
    }
    expect(await createSettler({ ...deps(), journal: broken }).settleNow(T)).toBe('unavailable')
  })
})

describe('settleNow: a held receipt', () => {
  it('submits its pending chain through settleReceipts and settles via markSettled', async () => {
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined, delivered: false }))
    settleReceiptsMock.mockImplementation(async p => {
      await p.markSettled?.(T)
      return [{ txid: T, assetId: A, status: 'admitted' }] as ReceiptSettleResult[]
    })
    const d = deps()
    expect(await createSettler(d).settleNow(T)).toBe('settled')
    expect(settleReceiptsMock).toHaveBeenCalledWith(
      expect.objectContaining({ ledger, overlayIdentityKey: EP.overlayIdentityKey, txids: [T] })
    )
    expect(d.markSettled).toHaveBeenCalledWith(T)
  })

  it('journals a final refusal of a receipt and aborts nothing', async () => {
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined, delivered: false }))
    settleReceiptsMock.mockResolvedValue([{ txid: T, assetId: A, status: 'refused', code: 'ERR_INPUT_SPENT' }])
    const d = deps()
    expect(await createSettler(d).settleNow(T)).toBe('refused')
    expect((await journal.get(T))!.code).toBe('ERR_INPUT_SPENT')
    expect(d.abort).not.toHaveBeenCalled()
  })

  it('catches the row up with a ledger record already settled and marked', async () => {
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined, delivered: false }))
    await ledger.put({ v: 1, txid: T, assetId: A, state: 'settled', outputs: [0], attestation: SIGMA, at: 2 })
    expect(await createSettler(deps()).settleNow(T)).toBe('settled')
  })
})

describe('settleAll', () => {
  it('settles every pending receipt and every DELIVERED own hand-over, single-flight', async () => {
    await journal.insert(row())
    await ownPending()
    await journal.insert(row({ txid: U, delivered: false }))
    await ownPending(U)
    admits()
    let release!: () => void
    settleReceiptsMock.mockImplementation(
      async () =>
        await new Promise<ReceiptSettleResult[]>(resolve => {
          release = () => resolve([])
        })
    )
    const s = createSettler(deps())
    const first = s.settleAll()
    const second = s.settleAll()
    await tick()
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(settleReceiptsMock).toHaveBeenCalledTimes(1)
    expect(settleReceiptsMock).toHaveBeenCalledWith(expect.not.objectContaining({ txids: expect.anything() }))
    expect(settleHandoverMock).toHaveBeenCalledTimes(1)
    expect((await journal.get(U))!.state).toBe('handed_over')
  })

  it('a receipt pass that throws does not stop the hand-overs', async () => {
    await journal.insert(row())
    await ownPending()
    settleReceiptsMock.mockRejectedValue(new Error('OVERLAY_IDENTITY_KEY_UNSET'))
    admits()
    expect(await createSettler(deps()).settleAll()).toBe(1)
    expect((await journal.get(T))!.state).toBe('settled')
  })

  describe('racing settleNow(T)', () => {
    it('moves a refused own hand-over once and aborts its action once', async () => {
      await journal.insert(row())
      await ownPending()
      settleHandoverMock.mockImplementation(async () => {
        await tick()
        return { status: 'refused', code: 'ERR_FROZEN' }
      })
      const abort = jest.fn(async () => ({ aborted: true }))
      const onChange = jest.fn()
      const s = createSettler(deps({ abort, onChange }))
      await Promise.all([s.settleAll(), s.settleNow(T)])
      expect((await journal.get(T))!.state).toBe('refused')
      expect(abort).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledTimes(1)
    })
  })
})

describe('readHandoverAdmission', () => {
  const tokenTx = (): Transaction => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('52') })
    return tx
  }

  it('true only for the queried outpoint, false on an empty list, a throw otherwise', () => {
    const tx = tokenTx()
    const txid = tx.id('hex')
    const beef = tx.toBEEF()
    expect(readHandoverAdmission({ type: 'output-list', outputs: [{ beef, outputIndex: 1 }] }, `${txid}.1`)).toBe(true)
    expect(readHandoverAdmission({ type: 'output-list', outputs: [{ beef, outputIndex: 1, txid }] }, `${txid}.1`)).toBe(
      true
    )
    expect(readHandoverAdmission({ type: 'output-list', outputs: [] }, `${txid}.1`)).toBe(false)
    // Another output of the same tx is not this hand-over's admission.
    expect(() =>
      readHandoverAdmission({ type: 'output-list', outputs: [{ beef, outputIndex: 0 }] }, `${txid}.1`)
    ).toThrow()
    expect(() =>
      readHandoverAdmission({ type: 'output-list', outputs: [{ beef, outputIndex: 1 }] }, `${'00'.repeat(32)}.1`)
    ).toThrow()
    expect(() =>
      readHandoverAdmission({ type: 'output-list', outputs: [{ beef, outputIndex: 5 }] }, `${txid}.5`)
    ).toThrow()
    expect(() =>
      readHandoverAdmission({ type: 'output-list', outputs: [{ beef: [1, 2, 3], outputIndex: 1 }] }, `${txid}.1`)
    ).toThrow()
    expect(() => readHandoverAdmission({ type: 'freeform', result: {} } as never, `${txid}.1`)).toThrow()
    expect(() => readHandoverAdmission(undefined as never, `${txid}.1`)).toThrow()
  })
})

// ─────────────────────────────── runtime wiring ───────────────────────────────

const pkh = (): number[] => Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])

function rec(over: Partial<InventoryRecord> = {}): InventoryRecord {
  return { outpoint: `${T}.0`, assetId: A, role: 'value', units: 1n, tags: ['color_state_available'], ...over }
}

function fakeWallet(inventory: InventoryRecord[] = []) {
  const listOutputs = jest.fn(async (args: { basket: string; offset?: number }) => {
    if (args.basket !== 'p color assets') throw new Error(`no basket ${args.basket}`)
    const outputs = inventory.map(r => ({
      outpoint: r.outpoint,
      satoshis: 1,
      spendable: true,
      lockingScript: new OneColor().lock(r.assetId, r.units, pkh()).toHex(),
      tags: r.tags
    }))
    return { totalOutputs: outputs.length, outputs: outputs.slice(args.offset ?? 0) }
  })
  const abortAction = jest.fn(async (_args: { reference: string }, _originator?: string) => ({ aborted: true }))
  const getPublicKey = jest.fn(async () => ({ publicKey: new PrivateKey(7).toPublicKey().toString() }))
  return { listOutputs, abortAction, getPublicKey } as unknown as WalletInterface & {
    listOutputs: typeof listOutputs
    abortAction: typeof abortAction
  }
}

const offlineProvider = (admission: ColorOverlayProvider['admission']): ColorOverlayProvider => ({
  spendability: async () => {
    throw new Error('unused')
  },
  admission,
  submit: async () => {
    throw new Error('unused')
  }
})

function transportError(): Error {
  return Object.assign(new Error('[ColorProviderError] overlay unreachable'), {
    name: 'ColorProviderError',
    code: 'ERR_UNAVAILABLE',
    retryable: true,
    transport: true
  })
}

function runtimeWith(
  o: {
    wallet?: ReturnType<typeof fakeWallet>
    admission?: ColorOverlayProvider['admission']
    color?: null
    provider?: null
    storage?: CreateMandalaRuntimeArgs['storage']
  } = {}
) {
  const color = { markSettled: jest.fn(async () => {}) }
  return createMandalaRuntime({
    wallet: o.wallet ?? fakeWallet(),
    adminOriginator: ADMIN,
    storage: o.storage ?? storage,
    chain: 'main',
    endpoints: EP,
    color: o.color === null ? undefined : (color as never),
    ledger,
    hostWallet: {} as WalletInterface,
    provider:
      o.provider === null
        ? undefined
        : offlineProvider(
            o.admission ??
              (async () => {
                throw transportError()
              })
          ),
    now: () => new Date(NOW)
  })
}

describe('runtime: settleNow / settleAll / reviewTokenHoldings', () => {
  it('aborts a refused hand-over through the bound manager as the admin originator, and notifies', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    await ownPending()
    const wallet = fakeWallet()
    settleHandoverMock.mockResolvedValue({ status: 'refused', code: 'ERR_FROZEN' })
    const rt = runtimeWith({ wallet })
    const listener = jest.fn()
    rt.subscribe(listener)
    expect(await rt.settleNow(T)).toBe('refused')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-T' }, ADMIN)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('settleAll returns how many rows changed', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    await ownPending()
    await journal.insert(row({ txid: U, role: 'received', state: 'held', reference: undefined }))
    admits()
    settleReceiptsMock.mockResolvedValue([{ txid: U, assetId: A, status: 'retry', code: 'ERR_UNAVAILABLE' }])
    const rt = runtimeWith()
    expect(await rt.settleAll()).toBe(1)
  })

  it('reviewTokenHoldings settles, then counts where every row stands', async () => {
    await journal.insert(row({ txid: '01'.repeat(32), state: 'handed_over' }))
    await ownPending('01'.repeat(32))
    await journal.insert(row({ txid: '02'.repeat(32), state: 'held', role: 'received', reference: undefined }))
    await journal.insert(row({ txid: '03'.repeat(32), state: 'refused' }))
    await journal.insert(row({ txid: '04'.repeat(32), state: 'cancelled' }))
    await journal.insert(row({ txid: '05'.repeat(32), state: 'parked' }))
    admits()
    expect(await runtimeWith().reviewTokenHoldings()).toEqual({
      settled: 1,
      refused: 1,
      pending: 2,
      unreachable: false
    })
  })

  it('reviewTokenHoldings is unreachable when every result is a transport retry', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    await ownPending()
    settleHandoverMock.mockResolvedValue({ status: 'retry', code: 'ERR_UNAVAILABLE' })
    expect(await runtimeWith().reviewTokenHoldings()).toEqual({
      settled: 0,
      refused: 0,
      pending: 1,
      unreachable: true
    })
    settleHandoverMock.mockResolvedValue({ status: 'retry', code: 'ERR_PAUSED' })
    expect((await runtimeWith().reviewTokenHoldings()).unreachable).toBe(false)
    await journal.advance(T, ['handed_over'], 'cancelled')
    expect((await runtimeWith().reviewTokenHoldings()).unreachable).toBe(false)
  })

  it('without the module nothing is settled and nothing is pretended', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const rt = runtimeWith({ color: null })
    expect(await rt.settleNow(T)).toBe('unavailable')
    expect(await rt.settleAll()).toBe(0)
    expect(await rt.reviewTokenHoldings()).toEqual({ settled: 0, refused: 0, pending: 1, unreachable: true })
    expect(settleHandoverMock).not.toHaveBeenCalled()
  })
})

describe('runtime: isHandoverAdmitted', () => {
  it('isHandoverAdmitted is undefined on transport failure and false on an empty answer', async () => {
    await journal.insert(row({ state: 'parked', outputIndex: 1 }))
    expect(await runtimeWith().isHandoverAdmitted(T)).toBeUndefined()
    const empty = jest.fn(async () => ({ type: 'output-list' as const, outputs: [] }))
    expect(await runtimeWith({ admission: empty }).isHandoverAdmitted(T)).toBe(false)
    expect(empty).toHaveBeenCalledWith(A, [`${T}.1`])
  })

  it('is true when the overlay lists the hand-over output', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    await journal.insert(row({ txid, state: 'parked', outputIndex: 0 }))
    const admission = jest.fn(async () => ({
      type: 'output-list' as const,
      outputs: [{ beef: tx.toBEEF(), outputIndex: 0 }]
    }))
    expect(await runtimeWith({ admission }).isHandoverAdmitted(txid)).toBe(true)
  })

  it('is undefined for an unreadable answer or a typed refusal, and false for a txid with no row', async () => {
    await journal.insert(row({ state: 'parked' }))
    const unrelated = jest.fn(async () => ({
      type: 'output-list' as const,
      outputs: [{ beef: [0], outputIndex: 0 }]
    }))
    expect(await runtimeWith({ admission: unrelated }).isHandoverAdmitted(T)).toBeUndefined()
    const typed = jest.fn(async () => {
      throw Object.assign(new Error('[ColorProviderError] unknown topic'), {
        name: 'ColorProviderError',
        code: 'ERR_UNKNOWN_TOPIC',
        retryable: false,
        transport: false
      })
    })
    expect(await runtimeWith({ admission: typed }).isHandoverAdmitted(T)).toBeUndefined()
    const asked = jest.fn(async () => ({ type: 'output-list' as const, outputs: [] }))
    expect(await runtimeWith({ admission: asked }).isHandoverAdmitted('c3'.repeat(32))).toBe(false)
    expect(asked).not.toHaveBeenCalled()
    expect(await runtimeWith({ provider: null }).isHandoverAdmitted(T)).toBeUndefined()
  })
})

describe('runtime: reconcileHeld', () => {
  it('reconcileHeld journals an unjournaled tagged receipt as held, never settled', async () => {
    const wallet = fakeWallet([
      rec({ outpoint: `${T}.0`, units: 40n, tags: ['color_state_available', 'color_offline'] })
    ])
    const rt = runtimeWith({ wallet })
    await rt.reconcileHeld([T])
    expect((await journal.get(T))!).toMatchObject({
      state: 'held',
      role: 'received',
      rail: 'external',
      assetId: A,
      units: 40n,
      outputIndex: 0,
      delivered: false
    })
  })

  it('journals an untagged receipt as settled, summing its records exactly', async () => {
    const wallet = fakeWallet([
      rec({ outpoint: `${T}.2`, units: MAX_U64 }),
      rec({ outpoint: `${T}.1`, units: 1n }),
      rec({ outpoint: `${U}.0`, units: 9n, tags: ['color_state_available', 'color_offline'] })
    ])
    const rt = runtimeWith({ wallet })
    const listener = jest.fn()
    rt.subscribe(listener)
    await rt.reconcileHeld([T])
    expect((await journal.get(T))!).toMatchObject({ state: 'settled', units: MAX_U64 + 1n, outputIndex: 1 })
    // Only the named txids are reconciled.
    expect(await journal.get(U)).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('holds when any record is offline, and treats a restricted record as never settled', async () => {
    const wallet = fakeWallet([
      rec({ outpoint: `${T}.0`, units: 5n }),
      rec({ outpoint: `${T}.1`, units: 5n, tags: ['color_state_reserved', 'color_offline'] }),
      rec({ outpoint: `${U}.0`, units: 5n, tags: ['color_state_restricted'] })
    ])
    await runtimeWith({ wallet }).reconcileHeld([T, U])
    expect((await journal.get(T))!.state).toBe('held')
    expect((await journal.get(U))!.state).toBe('held')
  })

  it('skips a txid with no records and never touches an existing non-held row', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const wallet = fakeWallet([rec({ outpoint: `${T}.0`, units: 5n })])
    const rt = runtimeWith({ wallet })
    await rt.reconcileHeld([T, U])
    expect((await journal.get(T))!).toMatchObject({ state: 'handed_over', role: 'sent' })
    expect(await journal.get(U)).toBeUndefined()
  })

  it('advances a held row whose records lost color_offline, and keeps one with no records held', async () => {
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined }))
    await journal.insert(row({ txid: U, role: 'received', state: 'held', reference: undefined }))
    const wallet = fakeWallet([rec({ outpoint: `${T}.0`, units: 5n })])
    await runtimeWith({ wallet }).reconcileHeld([T, U])
    expect((await journal.get(T))!.state).toBe('settled')
    expect((await journal.get(U))!.state).toBe('held')
  })

  // A third-party originator's token action (published, or BRC-177) is this
  // wallet's own send: the storage hold parks it with no journal row, and the
  // inventory then holds only its token CHANGE. Journaling that as a
  // `received`/`external` credit would show the sender's own change as an
  // incoming payment, so an own-funded txid (an outgoing action) is skipped.
  // Its release is the overlay's broadcast on admission (design §21), as for
  // an exact spend with no change; see the report's contract gaps.
  it('never journals an own outgoing action’s change as a receipt', async () => {
    raw
      .prepare(
        `INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (1, '2026-10-22', '2026-10-22', ?)`
      )
      .run('02'.padEnd(66, 'a'))
    raw
      .prepare(
        `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
         VALUES ('2026-10-22', '2026-10-22', 1, 'nosend', 'ref-ext', 1, -1, ?)`
      )
      .run(T)
    raw
      .prepare(
        `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
         VALUES ('2026-10-22', '2026-10-22', 1, 'unproven', 'ref-in', 0, 1, ?)`
      )
      .run(U)
    const wallet = fakeWallet([rec({ outpoint: `${T}.1`, units: 7n }), rec({ outpoint: `${U}.0`, units: 9n })])
    await runtimeWith({ wallet }).reconcileHeld([T, U])
    expect(await journal.get(T)).toBeUndefined()
    // An internalized receipt is still journaled as one.
    expect((await journal.get(U))!).toMatchObject({ role: 'received', rail: 'external', units: 9n, state: 'settled' })
  })

  it('is a no-op for an empty list, and propagates an inventory fault', async () => {
    const wallet = fakeWallet()
    await runtimeWith({ wallet }).reconcileHeld([])
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    const broken = fakeWallet()
    broken.listOutputs.mockRejectedValue(new Error('storage fault'))
    await expect(runtimeWith({ wallet: broken }).reconcileHeld([T])).rejects.toThrow(/storage fault/)
  })
})
