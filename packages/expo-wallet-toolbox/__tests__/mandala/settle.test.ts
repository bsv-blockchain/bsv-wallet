/**
 * Runtime settlement through the color module (plan 07 Task 12).
 *
 *  · `settleNow(txid)` names one row to `color.settle({ txids })`, coalesced
 *    per txid, and never for a row the payer withheld (`built`/`parked`) or a
 *    row already final. A thrown settle reads back as the row's current state.
 *  · `settleAll()` is bare `color.settle()`, single-flight.
 *  · A report maps onto the `color_transfers` journal with CAS transitions
 *    only; a refused own hand-over is journaled `refused` BEFORE its action is
 *    aborted, so the abort guard lets the inputs go.
 *  · `isHandoverAdmitted` answers `undefined` whenever the overlay cannot be
 *    asked or answers something it cannot read, and `false` only on an empty
 *    output list.
 *  · `reconcileHeld` journals an unjournaled receipt as `held` whenever any of
 *    its records is `color_offline` (never `settled`).
 *
 * The journal is real SQLite: the CAS and INSERT OR IGNORE are what the
 * concurrency pins prove.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Hash, LockingScript, PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import type { ColorOverlayProvider, ColorSettleReport } from '@bsv/color-permission-module'
import { applySettleReport, createSettler, readHandoverAdmission, type SettleDeps } from '../../core/mandala/settle'
import { createMandalaRuntime, type CreateMandalaRuntimeArgs } from '../../core/mandala/createRuntime'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import type { ColorTransferRow } from '../../core/mandala/types'
import type { InventoryRecord } from '../../core/mandala/assets'
import { openTestDb, type ExpoLikeDb } from '../__helpers__/nodeSqlite'

const ADMIN = 'admin.example'
const T = 'a1'.repeat(32)
const U = 'b2'.repeat(32)
const A = `${'ab'.repeat(32)}_0`
const OTHER_ASSET = `${'cd'.repeat(32)}_0`
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}
const MAX_U64 = 18446744073709551615n

let raw: DatabaseSync
let db: ExpoLikeDb
let journal: TransferJournal
let storage: CreateMandalaRuntimeArgs['storage']

beforeEach(async () => {
  let kv
  ;({ raw, db, kv } = await openTestDb())
  journal = createTransferJournal(db as JournalDb, () => new Date(NOW))
  storage = { getKeyValue: kv.getKeyValue, setKeyValue: kv.setKeyValue, sqliteDb: db } as never
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

type SettleFn = SettleDeps['color']['settle']

function deps(
  o: {
    settle?: SettleFn
    row?: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>>
    abort?: SettleDeps['abort']
    onChange?: () => void
  } = {}
) {
  return {
    color: { settle: o.settle ?? (jest.fn(async () => ({ results: [] })) as unknown as SettleFn) },
    journal,
    abort: o.abort ?? jest.fn(async () => ({ aborted: true })),
    onChange: o.onChange ?? jest.fn(),
    ...(o.row ? { seed: row(o.row) } : {})
  }
}

/** Seeds the journal with `seed` (when given) and returns the settler. */
async function settlerWith(d: ReturnType<typeof deps>) {
  if ('seed' in d && d.seed) await journal.insert(d.seed)
  return createSettler(d)
}

describe('settleNow', () => {
  it('coalesces concurrent settleNow(txid) onto one module call', async () => {
    const settle = jest.fn(async () => {
      await tick()
      return { results: [{ txid: T, assetId: A, status: 'admitted' as const, outputs: [0] }] }
    })
    const onChange = jest.fn()
    const s = await settlerWith(deps({ settle, row: { state: 'handed_over' }, onChange }))
    const [a, b] = await Promise.all([s.settleNow(T), s.settleNow(T)])
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith({ txids: [T] })
    expect(a).toBe('settled')
    expect(b).toBe('settled')
    expect((await journal.get(T))!.state).toBe('settled')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('never settles a built or parked row', async () => {
    const settle = jest.fn()
    const s = await settlerWith(deps({ settle: settle as never, row: { state: 'parked' } }))
    expect(await s.settleNow(T)).toBe('parked')
    await journal.insert(row({ txid: U, state: 'built' }))
    expect(await s.settleNow(U)).toBe('built')
    expect(settle).not.toHaveBeenCalled()
  })

  it('names neither a final row nor an unknown txid to the module', async () => {
    const settle = jest.fn()
    const s = await settlerWith(deps({ settle: settle as never, row: { state: 'cancelled' } }))
    expect(await s.settleNow(T)).toBe('cancelled')
    await journal.insert(row({ txid: U, state: 'settled' }))
    expect(await s.settleNow(U)).toBe('settled')
    expect(await s.settleNow('c3'.repeat(32))).toBe('unavailable')
    expect(settle).not.toHaveBeenCalled()
  })

  it('retries the abort of a refused own hand-over without naming it to the module', async () => {
    const settle = jest.fn()
    const abort = jest.fn(async () => ({ aborted: true }))
    const s = await settlerWith(deps({ settle: settle as never, abort, row: { state: 'refused', code: 'ERR_FROZEN' } }))
    expect(await s.settleNow(T)).toBe('refused')
    expect(abort).toHaveBeenCalledWith('ref-T')
    expect(settle).not.toHaveBeenCalled()
    // A refused receipt has no action to abort.
    await journal.insert(row({ txid: U, role: 'received', state: 'refused', reference: undefined }))
    expect(await s.settleNow(U)).toBe('refused')
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('settles a held receipt by name', async () => {
    const settle = jest.fn(async () => ({
      results: [{ txid: T, assetId: A, status: 'admitted' as const, outputs: [0] }]
    }))
    const s = await settlerWith(deps({ settle, row: { role: 'received', state: 'held', reference: undefined } }))
    expect(await s.settleNow(T)).toBe('settled')
  })

  it('retry changes nothing; a thrown settle reports the current state', async () => {
    const onChange = jest.fn()
    const settle = jest
      .fn<ReturnType<SettleFn>, Parameters<SettleFn>>()
      .mockResolvedValueOnce({ results: [{ txid: T, assetId: A, status: 'retry', code: 'ERR_UNAVAILABLE' }] })
      .mockRejectedValueOnce(new Error('store fault'))
      .mockResolvedValueOnce({ results: [{ txid: T, assetId: A, status: 'admitted', outputs: [0] }] })
    const s = await settlerWith(deps({ settle, row: { state: 'handed_over' }, onChange }))
    expect(await s.settleNow(T)).toBe('handed_over')
    expect(await s.settleNow(T)).toBe('handed_over')
    expect(onChange).not.toHaveBeenCalled()
    // The in-flight slot was released by the throw: the next call asks again.
    expect(await s.settleNow(T)).toBe('settled')
    expect(settle).toHaveBeenCalledTimes(3)
  })

  it('a thrown settle with an unreadable journal is unavailable, never a verdict', async () => {
    const settle = jest.fn(async () => {
      raw.exec('DROP TABLE color_transfers')
      throw new Error('store fault')
    })
    const s = await settlerWith(deps({ settle, row: { state: 'handed_over' } }))
    expect(await s.settleNow(T)).toBe('unavailable')
  })
})

describe('applySettleReport', () => {
  it('refused own hand-over is journaled refused, then aborted', async () => {
    const order: string[] = []
    await journal.insert(row({ state: 'handed_over' }))
    const spied: TransferJournal = {
      ...journal,
      advance: async (...a) => {
        order.push('journal')
        return await journal.advance(...a)
      }
    }
    const abort = jest.fn(async (reference: string) => {
      order.push('abort')
      // The abort guard reads the row: it must already say refused.
      expect((await journal.getByReference(reference))!.state).toBe('refused')
      return { aborted: true }
    })
    const d = { journal: spied, abort }
    const out = await applySettleReport(
      { results: [{ txid: T, assetId: A, status: 'refused', code: 'ERR_FROZEN' }] },
      d
    )
    expect(order).toEqual(['journal', 'abort'])
    expect(abort).toHaveBeenCalledWith('ref-T')
    expect((await d.journal.get(T))!.code).toBe('ERR_FROZEN')
    expect((await d.journal.get(T))!.state).toBe('refused')
    expect(out).toEqual({ changed: 1, settled: [] })
  })

  it('admitted advances every open state to settled and leaves final rows alone', async () => {
    const txids = ['01', '02', '03', '04', '05', '06'].map(b => b.repeat(32))
    const states = ['built', 'parked', 'handed_over', 'held', 'refused', 'cancelled'] as const
    for (let i = 0; i < txids.length; i++) {
      await journal.insert(row({ txid: txids[i], state: states[i], reference: `ref-${i}` }))
    }
    const report: ColorSettleReport = {
      results: txids.map(txid => ({ txid, assetId: A, status: 'admitted' as const, outputs: [0] }))
    }
    const abort = jest.fn(async () => ({ aborted: true }))
    const out = await applySettleReport(report, { journal, abort })
    expect(out).toEqual({ changed: 4, settled: txids.slice(0, 4) })
    const after = await journal.statesOf(txids)
    expect(txids.map(t => after.get(t))).toEqual(['settled', 'settled', 'settled', 'settled', 'refused', 'cancelled'])
    expect(abort).not.toHaveBeenCalled()
  })

  it('a refused receipt is journaled refused and nothing is aborted', async () => {
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined }))
    const abort = jest.fn(async () => ({ aborted: true }))
    await applySettleReport(
      { results: [{ txid: T, assetId: A, status: 'refused', code: 'ERR_PARENT_REFUSED' }] },
      { journal, abort }
    )
    expect((await journal.get(T))!).toMatchObject({ state: 'refused', code: 'ERR_PARENT_REFUSED' })
    expect(abort).not.toHaveBeenCalled()
  })

  it('a refused row whose abort failed is aborted again on the next report', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const abort = jest
      .fn<Promise<{ aborted: boolean }>, [string]>()
      .mockRejectedValueOnce(new Error('crashed mid-abort'))
      .mockResolvedValueOnce({ aborted: true })
    const report: ColorSettleReport = { results: [{ txid: T, assetId: A, status: 'refused', code: 'ERR_FROZEN' }] }
    await expect(applySettleReport(report, { journal, abort })).resolves.toEqual({ changed: 1, settled: [] })
    await expect(applySettleReport(report, { journal, abort })).resolves.toEqual({ changed: 0, settled: [] })
    expect(abort).toHaveBeenCalledTimes(2)
  })

  it('retry and unknown txids change nothing; a result for another asset is ignored', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const abort = jest.fn(async () => ({ aborted: true }))
    const out = await applySettleReport(
      {
        results: [
          { txid: T, assetId: A, status: 'retry', code: 'ERR_UNAVAILABLE' },
          { txid: T, assetId: OTHER_ASSET, status: 'admitted', outputs: [0] },
          { txid: 'c3'.repeat(32), assetId: A, status: 'admitted', outputs: [0] }
        ]
      },
      { journal, abort }
    )
    expect(out).toEqual({ changed: 0, settled: [] })
    expect((await journal.get(T))!.state).toBe('handed_over')
  })
})

describe('settleAll', () => {
  it('settleAll is single-flight', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const settle = jest.fn(async () => {
      await gate
      return { results: [{ txid: T, assetId: A, status: 'admitted' as const, outputs: [0] }] }
    })
    const onChange = jest.fn()
    const s = createSettler({ color: { settle }, journal, abort: async () => ({ aborted: true }), onChange })
    const first = s.settleAll()
    const second = s.settleAll()
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith()
    expect(onChange).toHaveBeenCalledTimes(1)
    // A later call is a new run.
    expect(await s.settleAll()).toBe(0)
    expect(settle).toHaveBeenCalledTimes(2)
  })

  // The per-txid single flight and the settle-all one are separate, so a tick's
  // settleAll() racing a screen's settleNow(T) makes two module calls that
  // both cover T. Exercised interleaving: settleAll() starts first, settleNow(T)
  // reads the row while it is still handed_over and names it, then both module
  // calls resolve with the same verdict and both reports are applied. The
  // journal CAS lets exactly one of them move the row.
  describe('racing settleNow(T)', () => {
    function gatedSettle(status: 'admitted' | 'refused') {
      let release: () => void = () => undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const result =
        status === 'admitted'
          ? { txid: T, assetId: A, status, outputs: [0] }
          : { txid: T, assetId: A, status, code: 'ERR_FROZEN' }
      const settle = jest.fn(async () => {
        await gate
        return { results: [result] } as unknown as ColorSettleReport
      })
      return { settle: settle as unknown as SettleFn & jest.Mock, release }
    }

    async function race(status: 'admitted' | 'refused') {
      await journal.insert(row({ state: 'handed_over' }))
      const advance = jest.spyOn(journal, 'advance')
      const { settle, release } = gatedSettle(status)
      const abort = jest.fn(async () => ({ aborted: true }))
      const onChange = jest.fn()
      const s = createSettler({ color: { settle }, journal, abort, onChange })
      const all = s.settleAll()
      const now = s.settleNow(T)
      // Let settleNow read the row and reach the module before either resolves.
      for (let i = 0; i < 5; i++) await tick()
      release()
      const [changed, state] = await Promise.all([all, now])
      const moved = (await Promise.all(advance.mock.results.map(r => r.value as Promise<boolean>))).filter(Boolean)
      advance.mockRestore()
      return { settle, abort, onChange, changed, state, moved }
    }

    it('moves an admitted row once', async () => {
      const r = await race('admitted')
      expect(r.settle).toHaveBeenCalledTimes(2)
      expect(r.settle).toHaveBeenCalledWith()
      expect(r.settle).toHaveBeenCalledWith({ txids: [T] })
      expect(r.moved).toHaveLength(1)
      expect(r.state).toBe('settled')
      expect((await journal.get(T))!.state).toBe('settled')
      expect(r.onChange).toHaveBeenCalledTimes(1)
      expect(r.abort).not.toHaveBeenCalled()
    })

    it('moves a refused own hand-over once and aborts its action once', async () => {
      const r = await race('refused')
      expect(r.settle).toHaveBeenCalledTimes(2)
      expect(r.moved).toHaveLength(1)
      expect(r.state).toBe('refused')
      expect(await journal.get(T)).toMatchObject({ state: 'refused', code: 'ERR_FROZEN' })
      expect(r.onChange).toHaveBeenCalledTimes(1)
      expect(r.abort).toHaveBeenCalledTimes(1)
      expect(r.abort).toHaveBeenCalledWith('ref-T')
    })
  })

  it('a thrown settleAll rejects and frees the slot', async () => {
    const settle = jest
      .fn<ReturnType<SettleFn>, Parameters<SettleFn>>()
      .mockRejectedValueOnce(new Error('store fault'))
      .mockResolvedValueOnce({ results: [] })
    const s = createSettler({ color: { settle }, journal, abort: async () => ({ aborted: true }), onChange: jest.fn() })
    await expect(s.settleAll()).rejects.toThrow(/store fault/)
    expect(await s.settleAll()).toBe(0)
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
    settle?: SettleFn
    admission?: ColorOverlayProvider['admission']
    color?: null
    provider?: null
    storage?: CreateMandalaRuntimeArgs['storage']
  } = {}
) {
  const color = {
    settle: o.settle ?? (jest.fn(async () => ({ results: [] })) as unknown as SettleFn),
    handoffEvidence: jest.fn(async () => undefined)
  }
  return createMandalaRuntime({
    wallet: o.wallet ?? fakeWallet(),
    adminOriginator: ADMIN,
    storage: o.storage ?? storage,
    chain: 'main',
    endpoints: EP,
    color: o.color === null ? undefined : (color as never),
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
    const wallet = fakeWallet()
    const settle = jest.fn(async () => ({
      results: [{ txid: T, assetId: A, status: 'refused' as const, code: 'ERR_FROZEN' }]
    }))
    const rt = runtimeWith({ wallet, settle })
    const listener = jest.fn()
    rt.subscribe(listener)
    expect(await rt.settleNow(T)).toBe('refused')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-T' }, ADMIN)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('settleAll returns how many rows changed', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    await journal.insert(row({ txid: U, role: 'received', state: 'held', reference: undefined }))
    const settle = jest.fn(async () => ({
      results: [
        { txid: T, assetId: A, status: 'admitted' as const, outputs: [0] },
        { txid: U, assetId: A, status: 'retry' as const, code: 'ERR_UNAVAILABLE' }
      ]
    }))
    const rt = runtimeWith({ settle })
    expect(await rt.settleAll()).toBe(1)
    expect(settle).toHaveBeenCalledWith()
  })

  it('reviewTokenHoldings settles, then counts where every row stands', async () => {
    await journal.insert(row({ txid: '01'.repeat(32), state: 'handed_over' }))
    await journal.insert(row({ txid: '02'.repeat(32), state: 'held', role: 'received', reference: undefined }))
    await journal.insert(row({ txid: '03'.repeat(32), state: 'refused' }))
    await journal.insert(row({ txid: '04'.repeat(32), state: 'cancelled' }))
    await journal.insert(row({ txid: '05'.repeat(32), state: 'parked' }))
    const settle = jest.fn(async () => ({
      results: [{ txid: '01'.repeat(32), assetId: A, status: 'admitted' as const, outputs: [0] }]
    }))
    expect(await runtimeWith({ settle }).reviewTokenHoldings()).toEqual({
      settled: 1,
      refused: 1,
      pending: 2,
      unreachable: false
    })
  })

  it('reviewTokenHoldings is unreachable when every result is a transport retry, or the module threw', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const retry = jest.fn(async () => ({
      results: [{ txid: T, assetId: A, status: 'retry' as const, code: 'ERR_UNAVAILABLE' }]
    }))
    expect(await runtimeWith({ settle: retry }).reviewTokenHoldings()).toEqual({
      settled: 0,
      refused: 0,
      pending: 1,
      unreachable: true
    })
    const other = jest.fn(async () => ({
      results: [{ txid: T, assetId: A, status: 'retry' as const, code: 'ERR_PARENT_PENDING' }]
    }))
    expect((await runtimeWith({ settle: other }).reviewTokenHoldings()).unreachable).toBe(false)
    const none = jest.fn(async () => ({ results: [] }))
    expect((await runtimeWith({ settle: none }).reviewTokenHoldings()).unreachable).toBe(false)
    const thrown = jest.fn(async () => {
      throw new Error('store fault')
    })
    expect(await runtimeWith({ settle: thrown }).reviewTokenHoldings()).toMatchObject({ pending: 1, unreachable: true })
  })

  it('without the module nothing is settled and nothing is pretended', async () => {
    await journal.insert(row({ state: 'handed_over' }))
    const rt = runtimeWith({ color: null })
    expect(await rt.settleNow(T)).toBe('unavailable')
    expect(await rt.settleAll()).toBe(0)
    expect(await rt.reviewTokenHoldings()).toEqual({ settled: 0, refused: 0, pending: 1, unreachable: true })
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
