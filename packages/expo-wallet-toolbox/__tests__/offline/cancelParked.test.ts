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
