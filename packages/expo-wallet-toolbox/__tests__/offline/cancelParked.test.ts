import {
  cancelParkedPayment as realCancelParkedPayment,
  mandalaSettlementDeps,
  runCancelParkedFlow
} from '../../core/offline/cancelParked'
import { updateOfflineAction } from '../../core/storage/methods/offlineActions'

jest.mock('../../core/storage/methods/offlineActions', () => ({
  updateOfflineAction: jest.fn().mockResolvedValue(undefined)
}))

const mockedUpdate = updateOfflineAction as jest.Mock
const TXID = 'bb'.repeat(32)

/**
 * Every call below pins connectivity explicitly, exactly like build.test.ts's
 * `finalizeDelivery` suite does — the real default (`@/core/net/online`'s
 * `getOnline`) reaches the native NetInfo module, which has nothing to answer
 * with under Jest and crashes the process rather than merely rejecting. Tests
 * that care about the new BSV-rail chain-status check (below) override this.
 */
function cancelParkedPayment(args: Parameters<typeof realCancelParkedPayment>[0]) {
  return realCancelParkedPayment({ isOnline: async () => true, ...args })
}

function stubs(tx: { reference?: string; status?: string } | null, aborted = true) {
  const storage = {
    sqliteDb: {},
    findTransactions: jest.fn().mockResolvedValue(tx ? [tx] : [])
  }
  const wallet = { abortAction: jest.fn().mockResolvedValue({ aborted }) }
  return { storage, wallet }
}

beforeEach(() => {
  mockedUpdate.mockClear()
  mockedUpdate.mockResolvedValue(undefined)
})

it('aborts the action by reference and retires the parked row', async () => {
  const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })

  const outcome = await cancelParkedPayment({ storage, wallet, originator: 'admin.com', txid: TXID })

  expect(outcome).toBe('cancelled')
  expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
  expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'acknowledged' })
})

it('will not release inputs once the transaction has been broadcast', async () => {
  const { storage, wallet } = stubs({ reference: 'ref-1', status: 'unproven' })

  const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID })

  expect(outcome).toBe('already-sent')
  expect(wallet.abortAction).not.toHaveBeenCalled()
  expect(mockedUpdate).not.toHaveBeenCalled()
})

it('reports a missing transaction rather than throwing', async () => {
  const { storage, wallet } = stubs(null)
  await expect(cancelParkedPayment({ storage, wallet, txid: TXID })).resolves.toBe('not-found')
})

it('keeps the parked row when the wallet refuses the abort', async () => {
  const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' }, false)

  await expect(cancelParkedPayment({ storage, wallet, txid: TXID })).rejects.toThrow(/refused/)
  expect(mockedUpdate).not.toHaveBeenCalled()
})

/**
 * P1-3-localpay-cancelparked-bsv: `cancelParkedPayment` had no chain-status
 * check of its own on the BSV rail — only the token overlay check above did,
 * and it is skipped entirely when `settlement` is omitted or the txid has no
 * settlement row. A payee who scanned a static QR and is holding it may have
 * already broadcast their copy; ask the network before trusting the local
 * `nosend` status, regardless of whether this is a token payment.
 */
describe('the BSV-rail chain-status check', () => {
  function withServices(status: string | undefined) {
    return {
      getServices: () => ({
        getStatusForTxids: jest.fn().mockResolvedValue(status ? { results: [{ txid: TXID, status }] } : { results: [] })
      })
    }
  }

  it('refuses the cancel when online and the network already knows the txid', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    Object.assign(storage, withServices('known'))

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, isOnline: async () => true })

    expect(outcome).toBe('already-sent')
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('cancels when online and the network has never seen the txid', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    Object.assign(storage, withServices(undefined))

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, isOnline: async () => true })

    expect(outcome).toBe('cancelled')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, undefined)
  })

  it('refuses to cancel silently while genuinely offline, without touching the wallet', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    Object.assign(storage, withServices('known'))

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, isOnline: async () => false })

    expect(outcome).toBe('unverifiable-offline')
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('cancels while offline once the caller acknowledges the risk', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    Object.assign(storage, withServices('known'))

    const outcome = await cancelParkedPayment({
      storage,
      wallet,
      txid: TXID,
      isOnline: async () => false,
      acknowledgedUnverifiable: true
    })

    expect(outcome).toBe('cancelled')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, undefined)
  })
})

/**
 * FIX J. A token payment's transaction can look perfectly cancellable here —
 * `nosend`, inputs still reserved — while the RECIPIENT's own drain has
 * already submitted it (rule 3: the recipient settles the hop). Aborting then
 * releases inputs the overlay considers spent, handing the payer a
 * double-spend against the person they just paid. So when online, the overlay
 * is asked first.
 */
describe('a token payment', () => {
  type Row = { txid: string; state: string }

  /** The journal slice cancel reads, with a CAS that records every transition. */
  function settlementDeps(
    opts: {
      row?: Row | null
      admitted?: boolean | undefined | 'throws'
      online?: boolean
      throws?: 'probe' | 'journal'
    } = {}
  ) {
    let row: Row | undefined = opts.row === null ? undefined : (opts.row ?? { txid: TXID, state: 'parked' })
    const transitions: string[] = []
    const isHandoverAdmitted = jest.fn(async () => {
      if (opts.admitted === 'throws') throw new Error('overlay unreachable')
      return opts.admitted
    })
    const journal = {
      get: jest.fn(async (txid: string) => {
        if (opts.throws === 'journal') throw new Error('SQLITE_BUSY')
        return (row && row.txid === txid ? { ...row } : undefined) as never
      }),
      advance: jest.fn(async (txid: string, from: readonly string[], to: string) => {
        if (!row || row.txid !== txid || !from.includes(row.state)) return false
        transitions.push(`${row.state}→${to}`)
        row = { ...row, state: to }
        return true
      })
    }
    return {
      transitions,
      deps: {
        isHandoverAdmitted,
        journal,
        isOnline: jest.fn(async () => {
          if (opts.throws === 'probe') throw new Error('netinfo blew up')
          return opts.online ?? true
        })
      }
    }
  }

  it('cancel of a parked token payment the overlay already admitted reports already-sent', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps, transitions } = settlementDeps({ admitted: true })

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })

    expect(outcome).toBe('already-sent')
    expect(deps.isHandoverAdmitted).toHaveBeenCalledWith(TXID)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
    // The overlay has it: the journal now says so, so the abort guard refuses.
    expect(transitions).toEqual(['parked→handed_over'])
  })

  it('cancels, then journals cancelled, when the overlay has not admitted it', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps, transitions } = settlementDeps({ admitted: false })
    const order: string[] = []
    wallet.abortAction.mockImplementation(async () => {
      order.push('abort')
      return { aborted: true }
    })
    deps.journal.advance.mockImplementationOnce(async () => {
      order.push('journal')
      transitions.push('parked→cancelled')
      return true
    })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, undefined)
    expect(order).toEqual(['abort', 'journal'])
    expect(deps.journal.advance).toHaveBeenCalledWith(TXID, ['built', 'parked'], 'cancelled')
    expect(transitions).toEqual(['parked→cancelled'])
    expect(mockedUpdate).toHaveBeenCalledWith({}, TXID, { status: 'acknowledged' })
  })

  it('cancels a built row the payee never received the same way', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps, transitions } = settlementDeps({ row: { txid: TXID, state: 'built' }, admitted: false })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(transitions).toEqual(['built→cancelled'])
  })

  it('a journal fault after the abort landed still reports cancelled', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ admitted: false })
    deps.journal.advance.mockRejectedValueOnce(new Error('SQLITE_BUSY'))

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(mockedUpdate).toHaveBeenCalled()
  })

  it.each([['handed_over'], ['settled']])(
    'refuses a row the journal already reads %s, without asking the overlay or the wallet',
    async state => {
      const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
      const { deps } = settlementDeps({ row: { txid: TXID, state }, admitted: false })

      await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('already-sent')
      expect(deps.isHandoverAdmitted).not.toHaveBeenCalled()
      expect(wallet.abortAction).not.toHaveBeenCalled()
    }
  )

  it("refuses to cancel silently when the overlay cannot answer — 'undefined' is not 'not admitted'", async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ admitted: undefined })

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })

    expect(outcome).toBe('unverifiable-offline')
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a throwing admission probe is the same unanswerable answer', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ admitted: 'throws' })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe(
      'unverifiable-offline'
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('cancels an unanswerable admission once acknowledged, and journals it cancelled', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps, transitions } = settlementDeps({ admitted: undefined })

    const outcome = await cancelParkedPayment({
      storage,
      wallet,
      txid: TXID,
      settlement: deps,
      acknowledgedUnverifiable: true
    })

    expect(outcome).toBe('cancelled')
    expect(transitions).toEqual(['parked→cancelled'])
  })

  it('refuses to cancel silently while offline when a row exists to protect', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ online: false, admitted: true })

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })

    expect(outcome).toBe('unverifiable-offline')
    expect(deps.isHandoverAdmitted).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('cancels while offline once acknowledged', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ online: false, admitted: true })

    const outcome = await cancelParkedPayment({
      storage,
      wallet,
      txid: TXID,
      settlement: deps,
      acknowledgedUnverifiable: true
    })

    expect(outcome).toBe('cancelled')
    expect(deps.isHandoverAdmitted).not.toHaveBeenCalled()
  })

  it('refuses to cancel silently when the settlement connectivity probe throws', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ throws: 'probe' })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe(
      'unverifiable-offline'
    )
    expect(deps.isHandoverAdmitted).not.toHaveBeenCalled()
  })

  it('never asks the overlay for a txid with no journal row', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ row: null })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(deps.isHandoverAdmitted).not.toHaveBeenCalled()
    expect(deps.journal.advance).not.toHaveBeenCalled()
  })

  it('a journal read fault refuses the cancel rather than reading as no row', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ throws: 'journal' })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).rejects.toThrow('SQLITE_BUSY')
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('still refuses a transaction that has left nosend, admitted or not', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'unproven' })
    const { deps } = settlementDeps({ admitted: false })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('already-sent')
  })
})

describe('mandalaSettlementDeps', () => {
  it('is undefined while Mandala is unavailable, so a BSV cancel is untouched', () => {
    expect(mandalaSettlementDeps(undefined)).toBeUndefined()
    expect(
      mandalaSettlementDeps({ available: false, isHandoverAdmitted: jest.fn(), journal: {} as never })
    ).toBeUndefined()
  })

  it('reads admission and the journal straight off the runtime', async () => {
    const isHandoverAdmitted = jest.fn(async () => true)
    const journal = { get: jest.fn(), advance: jest.fn() }
    const isOnline = async () => true
    const deps = mandalaSettlementDeps({ available: true, isHandoverAdmitted, journal: journal as never }, isOnline)
    expect(deps?.journal).toBe(journal)
    expect(deps?.isOnline).toBe(isOnline)
    await expect(deps?.isHandoverAdmitted(TXID)).resolves.toBe(true)
    expect(isHandoverAdmitted).toHaveBeenCalledWith(TXID)
  })
})

/**
 * `runCancelParkedFlow` is the UI-facing glue extracted so it can be unit
 * tested without mounting the whole WalletHomeScreen: it calls `cancel()`
 * once, and only on `unverifiable-offline` shows the destructive confirm and,
 * if accepted, calls `cancel()` again with the acknowledgement.
 */
describe('runCancelParkedFlow', () => {
  it('returns the outcome directly when it is not unverifiable-offline', async () => {
    const cancel = jest.fn().mockResolvedValue('cancelled')
    const confirmUnverifiable = jest.fn()

    const outcome = await runCancelParkedFlow({ cancel, confirmUnverifiable })

    expect(outcome).toBe('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(undefined)
    expect(confirmUnverifiable).not.toHaveBeenCalled()
  })

  it('shows the confirm and retries with the flag when accepted', async () => {
    const cancel = jest.fn().mockResolvedValueOnce('unverifiable-offline').mockResolvedValueOnce('cancelled')
    const confirmUnverifiable = jest.fn().mockResolvedValue(true)

    const outcome = await runCancelParkedFlow({ cancel, confirmUnverifiable })

    expect(outcome).toBe('cancelled')
    expect(cancel).toHaveBeenNthCalledWith(1, undefined)
    expect(cancel).toHaveBeenNthCalledWith(2, true)
    expect(confirmUnverifiable).toHaveBeenCalledTimes(1)
  })

  it('never retries when the confirm is declined', async () => {
    const cancel = jest.fn().mockResolvedValue('unverifiable-offline')
    const confirmUnverifiable = jest.fn().mockResolvedValue(false)

    const outcome = await runCancelParkedFlow({ cancel, confirmUnverifiable })

    expect(outcome).toBe('unverifiable-offline')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
