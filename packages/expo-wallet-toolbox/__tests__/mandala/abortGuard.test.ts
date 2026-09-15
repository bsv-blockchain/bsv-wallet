/**
 * Guard #4 — the 2026-09-15 incident, as a test.
 *
 * On that day a token transfer (6597db42…) was admitted by the issuer's
 * overlay, which broadcasts on admission, and 0.7 s later the wallet aborted
 * the still-`noSend` action that built it: `proven_tx_reqs` went
 * `nosend → abortAction → invalid`, `transactions.status` went `failed`, and
 * the input coin (f6d80d2e….2) came back spendable although it was spent on
 * chain. The next send reused it and the overlay refused the child with
 * `ERR_INPUT_SPENT`.
 *
 * The abort came from the lib's bulk sweep, but the rule this pins is
 * caller-agnostic on purpose: NOTHING may abort the action behind a token
 * payment once the bytes have left this device. The row's `state` is the whole
 * decision, and it is read from a REAL settlement store over real SQLite, so a
 * column that stopped being written (or an index that stopped being used) fails
 * here rather than on a phone holding money.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import {
  abortIsBlockedBy,
  wrapAbortActionForSettlements,
  ABORT_BLOCKED_SETTLEMENT_STATES
} from '../../core/mandala/abortGuard'
import type { SettlementStore, TokenSettlementState } from '../../core/mandala/types'

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

const TXID = '6597db42' + 'ab'.repeat(28)
const REFERENCE = 'cmVmZXJlbmNlLW9mLXRoZS1ub1NlbmQtYWN0aW9u'
const OVERLAY_KEY = '02' + 'cd'.repeat(32)

let raw: DatabaseSync
let store: SettlementStore
let warn: jest.SpyInstance

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  const db = adapt(raw)
  await createTables(db as never)
  store = createSettlementStore(db as unknown as SettlementDb)
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  raw.close()
})

async function rowInState(state: TokenSettlementState, reference: string | undefined = REFERENCE): Promise<void> {
  await store.upsertSettlement({
    txid: TXID,
    role: 'sent',
    assetId: `${'ee'.repeat(32)}.0`,
    state,
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: OVERLAY_KEY,
    ...(reference ? { reference } : {})
  })
}

function managerWith(abortAction = jest.fn(async () => ({ aborted: true }))) {
  const manager = { abortAction, createAction: jest.fn(async () => ({ txid: 'x' })), marker: 7 }
  return { manager, abortAction }
}

describe('the settlement row carries the action reference', () => {
  it('stores and reads back a reference, through the indexed lookup', async () => {
    await rowInState('handed_over')
    const found = await store.getSettlementByReference(REFERENCE)
    expect(found?.txid).toBe(TXID)
    expect(found?.reference).toBe(REFERENCE)
    expect((await store.getSettlement(TXID))?.reference).toBe(REFERENCE)
  })

  it('never answers for an empty or unknown reference', async () => {
    await rowInState('admitted')
    expect(await store.getSettlementByReference('')).toBeUndefined()
    expect(await store.getSettlementByReference('some-other-action')).toBeUndefined()
  })

  it('keeps a reference an earlier pass recorded when a re-derivation has none (FIX G)', async () => {
    await rowInState('handed_over')
    // Exactly what `reconcileSettlements` does every tick, from frame bytes
    // that carry no wallet action reference at all.
    await rowInState('handed_over', undefined)
    expect((await store.getSettlement(TXID))?.reference).toBe(REFERENCE)
  })
})

describe('abortIsBlockedBy', () => {
  it('blocks exactly the states in which the payee or the overlay may hold the bytes', () => {
    expect([...ABORT_BLOCKED_SETTLEMENT_STATES].sort()).toEqual(
      ['admitted', 'broadcast', 'handed_over', 'held', 'submitting'].sort()
    )
  })

  it('allows every state the payer still owns, and every terminal refusal', () => {
    for (const state of ['built', 'parked', 'refused', 'orphaned'] as TokenSettlementState[]) {
      expect(abortIsBlockedBy({ state } as never)).toBe(false)
    }
  })

  it('allows an unknown reference — no row is not evidence of a payment', () => {
    expect(abortIsBlockedBy(undefined)).toBe(false)
  })
})

describe('wrapAbortActionForSettlements', () => {
  // The incident's own state, and the four others that share its hazard.
  for (const state of ABORT_BLOCKED_SETTLEMENT_STATES) {
    it(`refuses an abort whose reference names a '${state}' settlement`, async () => {
      await rowInState(state)
      const { manager, abortAction } = managerWith()
      const wrapped = wrapAbortActionForSettlements(manager, () => store)

      await expect(wrapped.abortAction({ reference: REFERENCE }, 'admin.example')).resolves.toEqual({ aborted: false })
      // The load-bearing assertion: the real abort never ran, so the inputs
      // were never released.
      expect(abortAction).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(TXID))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(state))
    })
  }

  for (const state of ['built', 'parked', 'refused', 'orphaned'] as TokenSettlementState[]) {
    it(`lets an abort through for a '${state}' settlement — those inputs SHOULD come back`, async () => {
      await rowInState(state)
      const { manager, abortAction } = managerWith()
      const wrapped = wrapAbortActionForSettlements(manager, () => store)

      await expect(wrapped.abortAction({ reference: REFERENCE }, 'admin.example')).resolves.toEqual({ aborted: true })
      expect(abortAction).toHaveBeenCalledWith({ reference: REFERENCE }, 'admin.example')
    })
  }

  it('lets an unknown reference through — every plain BSV abort in the wallet is one', async () => {
    await rowInState('admitted')
    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store)

    await expect(wrapped.abortAction({ reference: 'a-bsv-payment' })).resolves.toEqual({ aborted: true })
    expect(abortAction).toHaveBeenCalledTimes(1)
  })

  it('fails OPEN when the store is unavailable or throws — one bad read must not strand the wallet', async () => {
    const { manager, abortAction } = managerWith()

    const noStore = wrapAbortActionForSettlements(manager, () => undefined)
    await expect(noStore.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: true })

    const throwing = wrapAbortActionForSettlements(manager, () => ({
      getSettlementByReference: async () => {
        throw new Error('database is not open')
      }
    }))
    await expect(throwing.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: true })
    expect(abortAction).toHaveBeenCalledTimes(2)
  })

  it('reads the store LATE, so a rebuilt wallet is guarded by its own tables', async () => {
    await rowInState('admitted')
    let current: SettlementStore | undefined
    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => current)

    // Built before the runtime exists — exactly the order WalletContext wires.
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: true })
    current = store
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(abortAction).toHaveBeenCalledTimes(1)
  })

  it('passes every other method and property straight through', async () => {
    const { manager } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store)
    await wrapped.createAction!({} as never)
    expect(manager.createAction).toHaveBeenCalledTimes(1)
    expect(wrapped.marker).toBe(7)
  })
})
