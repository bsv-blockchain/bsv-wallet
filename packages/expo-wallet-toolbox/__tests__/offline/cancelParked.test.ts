import { cancelParkedPayment } from '../../core/offline/cancelParked'
import { updateOfflineAction } from '../../core/storage/methods/offlineActions'

jest.mock('../../core/storage/methods/offlineActions', () => ({
  updateOfflineAction: jest.fn().mockResolvedValue(undefined)
}))

const mockedUpdate = updateOfflineAction as jest.Mock
const TXID = 'bb'.repeat(32)

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
          getSettlement: jest.fn(async () =>
            (opts.row === undefined ? { overlayUrl: OVERLAY } : opts.row) as never
          )
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
