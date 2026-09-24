import { cancelParkedPayment as realCancelParkedPayment, runCancelParkedFlow } from '../../core/offline/cancelParked'
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
  const OVERLAY = 'https://overlay.issuer.example'

  function settlementDeps(
    opts: {
      row?: { overlayUrl: string } | undefined
      verdict?: unknown
      online?: boolean
      throws?: 'probe' | 'fetch'
    } = {}
  ) {
    const fetchAdmission = jest.fn(async () => {
      if (opts.throws === 'fetch') throw new Error('overlay unreachable')
      return opts.verdict as never
    })
    return {
      fetchAdmission,
      deps: {
        settlements: {
          getSettlement: jest.fn(async () => (opts.row === undefined ? { overlayUrl: OVERLAY } : opts.row) as never)
        },
        fetchAdmission,
        isOnline: jest.fn(async () => {
          if (opts.throws === 'probe') throw new Error('netinfo blew up')
          return opts.online ?? true
        })
      }
    }
  }

  it('refuses the cancel when the overlay already admitted it', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ verdict: { kind: 'admitted', outputsToAdmit: [0] } })

    const outcome = await cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })

    expect(outcome).toBe('already-sent')
    expect(deps.fetchAdmission).toHaveBeenCalledWith(OVERLAY, TXID)
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('cancels when the overlay has never seen the txid', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ verdict: undefined })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(wallet.abortAction).toHaveBeenCalled()
  })

  it('cancels when the overlay reports a refusal rather than an admission', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ verdict: { kind: 'refused', code: 'ERR_SHAPE' } })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
  })

  it('never polls when offline — there is nothing to ask', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ online: false, verdict: { kind: 'admitted', outputsToAdmit: [0] } })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(deps.fetchAdmission).not.toHaveBeenCalled()
  })

  it('never polls for a txid with no settlement row', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ row: undefined as never, verdict: undefined })
    deps.settlements.getSettlement = jest.fn(async () => undefined as never)

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(deps.fetchAdmission).not.toHaveBeenCalled()
  })

  it('falls back to the local check when the overlay cannot be reached', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ throws: 'fetch' })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
  })

  it('falls back to the local check when the connectivity probe throws', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'nosend' })
    const { deps } = settlementDeps({ throws: 'probe' })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('cancelled')
    expect(deps.fetchAdmission).not.toHaveBeenCalled()
  })

  it('still refuses a transaction that has left nosend, admitted or not', async () => {
    const { storage, wallet } = stubs({ reference: 'ref-1', status: 'unproven' })
    const { deps } = settlementDeps({ verdict: undefined })

    await expect(cancelParkedPayment({ storage, wallet, txid: TXID, settlement: deps })).resolves.toBe('already-sent')
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
