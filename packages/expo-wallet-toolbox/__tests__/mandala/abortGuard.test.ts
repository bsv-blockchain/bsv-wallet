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
      const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

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
      const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

      await expect(wrapped.abortAction({ reference: REFERENCE }, 'admin.example')).resolves.toEqual({ aborted: true })
      expect(abortAction).toHaveBeenCalledWith({ reference: REFERENCE }, 'admin.example')
    })
  }

  it('lets an unknown reference through — every plain BSV abort in the wallet is one', async () => {
    await rowInState('admitted')
    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

    await expect(wrapped.abortAction({ reference: 'a-bsv-payment' })).resolves.toEqual({ aborted: true })
    expect(abortAction).toHaveBeenCalledTimes(1)
  })

  // XR-034 (SEC1-024 / SEC2-038). The store lookup, the legacy-row check, and
  // a missing runtime on a Mandala-capable chain all used to fail OPEN — a
  // read fault or "no runtime right now" was treated as "safe to abort",
  // which is backwards: none of these are evidence that no token payment is
  // in flight, only that this call cannot currently tell. XR-034 replaces
  // that with fail CLOSED, gated only on whether a blocking row could ever
  // have existed at all (`tokenSettlementPossible`).
  describe('XR-034: fails CLOSED whenever a blocking row could exist but cannot be read', () => {
    it('XR-034: refuses when the settlement lookup throws', async () => {
      const { manager, abortAction } = managerWith()
      const throwing = wrapAbortActionForSettlements(
        manager,
        () => ({
          getSettlementByReference: async () => {
            throw new Error('database is not open')
          },
          hasUnresolvedLegacyBlockedRows: async () => false
        }),
        () => true
      )

      await expect(throwing.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
      // The load-bearing assertion: a lookup fault must never reach the real
      // abort, or a handed-over/admitted/broadcast token's inputs could be
      // released out from under it.
      expect(abortAction).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    })

    it('XR-034: refuses when hasUnresolvedLegacyBlockedRows throws', async () => {
      await rowInState('built') // getSettlementByReference resolves cleanly with a non-blocking row
      const { manager, abortAction } = managerWith()
      const throwingLegacyCheck = wrapAbortActionForSettlements(
        manager,
        () => ({
          getSettlementByReference: store.getSettlementByReference.bind(store),
          hasUnresolvedLegacyBlockedRows: async () => {
            throw new Error('index corrupt')
          }
        }),
        () => true
      )

      await expect(throwingLegacyCheck.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
      expect(abortAction).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    })

    it('XR-034: refuses when settlements() is undefined and this chain can carry token payments — the runtime may simply not be built yet, or be mid-rebuild', async () => {
      const { manager, abortAction } = managerWith()
      const noRuntimeYet = wrapAbortActionForSettlements(manager, () => undefined, () => true)

      await expect(noRuntimeYet.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
      expect(abortAction).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    })

    it('XR-034: allows abort when settlements() is undefined but this chain never had Mandala configured — no row could ever have been written', async () => {
      const { manager, abortAction } = managerWith()
      const neverConfigured = wrapAbortActionForSettlements(manager, () => undefined, () => false)

      await expect(neverConfigured.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: true })
      expect(abortAction).toHaveBeenCalledWith({ reference: REFERENCE }, undefined)
    })

    it('XR-034: readable-no-row control — a plain BSV abort still succeeds when the store answers and has nothing blocking', async () => {
      await rowInState('admitted') // a row exists, but for a DIFFERENT reference
      const { manager, abortAction } = managerWith()
      const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

      await expect(wrapped.abortAction({ reference: 'a-bsv-payment' })).resolves.toEqual({ aborted: true })
      expect(abortAction).toHaveBeenCalledWith({ reference: 'a-bsv-payment' }, undefined)
    })
  })

  it('reads the store LATE, so a rebuild is guarded throughout — before AND after its own tables exist', async () => {
    await rowInState('admitted')
    let current: SettlementStore | undefined
    const { manager, abortAction } = managerWith()
    // XR-034: while the runtime has not been (re)built yet, this chain is
    // still Mandala-capable, so `settlements() === undefined` must refuse —
    // exactly the window a rebuild's stale ref passes through in production.
    const wrapped = wrapAbortActionForSettlements(manager, () => current, () => true)

    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(abortAction).not.toHaveBeenCalled()
    // The runtime finishes rebuilding and the ref now resolves to a real
    // store — late binding picks that up, and the row it finds (still
    // 'admitted') keeps the abort refused, now for a fully evidenced reason.
    current = store
    await expect(wrapped.abortAction({ reference: REFERENCE })).resolves.toEqual({ aborted: false })
    expect(abortAction).not.toHaveBeenCalled()
  })

  it('passes every other method and property straight through', async () => {
    const { manager } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)
    await wrapped.createAction!({} as never)
    expect(manager.createAction).toHaveBeenCalledTimes(1)
    expect(wrapped.marker).toBe(7)
  })

  // XR-033: a row that predates the `reference` column (or whose migration-time
  // backfill could not resolve one) reads back `reference === undefined`
  // forever, so `getSettlementByReference` can never match it against ANY
  // reference — a legacy row stuck in a blocked state is invisible to the
  // primary check no matter which action is later aborted.
  it('XR-033: refuses every abort while a legacy reference-less row is stuck in a blocked state', async () => {
    // Bypasses `upsertSettlement` on purpose, to simulate a genuinely
    // pre-migration row: written with SQL alone, `reference` left NULL.
    raw
      .prepare(
        `INSERT INTO token_settlements
           (txid, role, assetId, state, overlayUrl, overlayIdentityKey, reference, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,NULL,?,?)`
      )
      .run(TXID, 'sent', `${'ee'.repeat(32)}.0`, 'handed_over', 'https://overlay.issuer.example', OVERLAY_KEY, 'n', 'n')

    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

    // A reference that names some OTHER, unrelated action — the legacy row
    // has none to match against, which is exactly the gap.
    await expect(wrapped.abortAction({ reference: 'some-unrelated-action-reference' })).resolves.toEqual({
      aborted: false
    })
    expect(abortAction).not.toHaveBeenCalled()
  })

  it('does not refuse an unrelated abort once the legacy row is reconciled', async () => {
    raw
      .prepare(
        `INSERT INTO token_settlements
           (txid, role, assetId, state, overlayUrl, overlayIdentityKey, reference, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,NULL,?,?)`
      )
      .run(TXID, 'sent', `${'ee'.repeat(32)}.0`, 'handed_over', 'https://overlay.issuer.example', OVERLAY_KEY, 'n', 'n')
    // Reconciled: the row now has a reference, so it is no longer "legacy and
    // unresolved" — the coarse check must stand down for everyone else.
    raw.prepare('UPDATE token_settlements SET reference = ? WHERE txid = ?').run(REFERENCE, TXID)

    const { manager, abortAction } = managerWith()
    const wrapped = wrapAbortActionForSettlements(manager, () => store, () => true)

    await expect(wrapped.abortAction({ reference: 'some-unrelated-action-reference' })).resolves.toEqual({
      aborted: true
    })
    expect(abortAction).toHaveBeenCalledTimes(1)
  })
})
