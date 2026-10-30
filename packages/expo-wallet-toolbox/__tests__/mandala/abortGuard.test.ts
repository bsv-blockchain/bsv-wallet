/**
 * Guard #4 — the 2026-09-15 incident, as a test, now keyed on `color_transfers`.
 *
 * On that day a token transfer (6597db42…) was admitted by the issuer's
 * overlay, which broadcasts on admission, and 0.7 s later the wallet aborted
 * the still-`noSend` action that built it: `proven_tx_reqs` went
 * `nosend → abortAction → invalid`, `transactions.status` went `failed`, and
 * the input coin (f6d80d2e….2) came back spendable although it was spent on
 * chain. The next send reused it and the overlay refused the child with
 * `ERR_INPUT_SPENT`.
 *
 * The rule this pins is caller-agnostic on purpose: NOTHING may abort the
 * action behind a token payment once the bytes have left this device. The
 * journal row's `state` is the whole decision (plan 07, W1), and it is read
 * from a REAL `color_transfers` journal over real SQLite, so a column that
 * stopped being written (or a lookup that stopped matching) fails here rather
 * than on a phone holding money.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  abortIsBlockedBy,
  wrapAbortActionForSettlements,
  ABORT_BLOCKED_TRANSFER_STATES
} from '../../core/mandala/abortGuard'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import type { ColorTransferRow, ColorTransferState } from '../../core/mandala/types'
import { openTestDb } from '../__helpers__/nodeSqlite'

const TXID = '6597db42' + 'ab'.repeat(28)
const REFERENCE = 'r1'
const ASSET = `${'ee'.repeat(32)}_0`

let raw: DatabaseSync
let journal: TransferJournal
let warn: jest.SpyInstance

beforeEach(async () => {
  let db
  ;({ raw, db } = await openTestDb())
  journal = createTransferJournal(db as JournalDb)
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  raw.close()
})

function managerWith(
  abortAction = jest.fn<Promise<{ aborted: boolean }>, [{ reference: string }, string?]>(async () => ({
    aborted: true
  }))
) {
  const manager = {
    abortAction,
    createAction: jest.fn<Promise<{ txid: string }>, [unknown]>(async () => ({ txid: 'x' })),
    marker: 7
  }
  return { manager, abortAction }
}

/** Writes one real journal row for REFERENCE and returns a fresh manager to guard. */
async function rowWith(over: Partial<Pick<ColorTransferRow, 'state' | 'delivered' | 'reference'>> = {}) {
  await journal.insert({
    txid: TXID,
    role: 'sent',
    assetId: ASSET,
    units: 18446744073709551615n,
    outputIndex: 0,
    rail: 'handle',
    state: 'built',
    delivered: false,
    reference: REFERENCE,
    ...over
  })
  return managerWith()
}

function wrap({ manager }: ReturnType<typeof managerWith>) {
  return wrapAbortActionForSettlements(
    manager,
    () => journal,
    () => true
  )
}

describe('abortIsBlockedBy', () => {
  it('blocks exactly the states in which the payee or the overlay may hold the bytes', () => {
    expect([...ABORT_BLOCKED_TRANSFER_STATES].sort()).toEqual(['handed_over', 'settled'])
  })

  it('allows every state the payer still owns, and every terminal refusal', () => {
    for (const state of ['built', 'parked', 'refused', 'cancelled'] as ColorTransferState[]) {
      expect(abortIsBlockedBy({ state } as never)).toBe(false)
    }
  })

  it('allows an unknown reference — no row is not evidence of a payment', () => {
    expect(abortIsBlockedBy(undefined)).toBe(false)
  })
})

describe('wrapAbortActionForSettlements', () => {
  it.each(['built', 'parked', 'refused', 'cancelled'] as const)('lets %s abort', async state => {
    const m = await rowWith({ state })
    await expect(wrap(m).abortAction({ reference: REFERENCE }, 'admin.example')).resolves.toEqual({ aborted: true })
    expect(m.abortAction).toHaveBeenCalledWith({ reference: REFERENCE }, 'admin.example')
  })

  it('refuses abort for a handed_over row whatever delivered says', async () => {
    for (const delivered of [true, false]) {
      raw.prepare('DELETE FROM color_transfers').run()
      const m = await rowWith({ state: 'handed_over', delivered })
      await expect(wrap(m).abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
      // The load-bearing assertion: the real abort never ran, so the inputs
      // were never released.
      expect(m.abortAction).not.toHaveBeenCalled()
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TXID))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('handed_over'))
  })

  it('refuses abort for a settled row', async () => {
    const m = await rowWith({ state: 'settled' })
    await expect(wrap(m).abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(m.abortAction).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settled'))
  })

  it('refuses once the row advances to handed_over, after letting the same reference through while built', async () => {
    const m = await rowWith({ state: 'built' })
    const wrapped = wrap(m)
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: true })
    expect(await journal.advance(TXID, ['built'], 'handed_over')).toBe(true)
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(m.abortAction).toHaveBeenCalledTimes(1)
  })

  it('lets an unknown reference through — every plain BSV abort in the wallet is one', async () => {
    const m = await rowWith({ state: 'handed_over' })
    await expect(wrap(m).abortAction({ reference: 'a-bsv-payment' })).resolves.toEqual({ aborted: true })
    expect(m.abortAction).toHaveBeenCalledWith({ reference: 'a-bsv-payment' }, undefined)
  })

  it('fails closed when the journal is unavailable on a Mandala chain, open when Mandala is impossible', async () => {
    const { manager: inner, abortAction } = managerWith()
    expect(
      await wrapAbortActionForSettlements(
        inner,
        () => undefined,
        () => true
      ).abortAction({ reference: 'r' })
    ).toEqual({ aborted: false })
    expect(abortAction).not.toHaveBeenCalled()
    expect(
      await wrapAbortActionForSettlements(
        inner,
        () => undefined,
        () => false
      ).abortAction({ reference: 'r' })
    ).toEqual({ aborted: true })
    expect(abortAction).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a journal read fault', async () => {
    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(
      manager,
      () => ({
        getByReference: async () => {
          throw new Error('database is locked')
        }
      }),
      () => true
    )
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(abortAction).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('fails closed, without throwing, when the journal lookup itself throws', async () => {
    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(
      manager,
      () => {
        throw new Error('runtime torn down')
      },
      () => true
    )
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(abortAction).not.toHaveBeenCalled()
  })

  it('reads the journal LATE, so a rebuild is guarded throughout', async () => {
    const m = await rowWith({ state: 'handed_over' })
    let current: TransferJournal | undefined
    const wrapped = wrapAbortActionForSettlements(
      m.manager,
      () => current,
      () => true
    )
    // Runtime not (re)built yet on a Mandala-capable chain: refuse.
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    // Rebuilt: late binding finds the real row, which still refuses.
    current = journal
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(m.abortAction).not.toHaveBeenCalled()
  })

  it('passes every other method and property straight through', async () => {
    const m = managerWith()
    const wrapped = wrap(m)
    await wrapped.createAction({} as never)
    expect(m.manager.createAction).toHaveBeenCalledTimes(1)
    expect(wrapped.marker).toBe(7)
  })
})
