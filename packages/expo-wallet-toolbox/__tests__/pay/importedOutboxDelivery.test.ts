// These dependencies are outside retryDelivery's boundary. Never construct a
// wire client or monitor; execute the real delivery function, outbox and SDK.
jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn(() => { throw new Error('wire client must not be constructed') })
}))
jest.mock('../../core/monitor/TaskDrainOutbox', () => ({ TaskDrainOutbox: jest.fn() }))
jest.mock('../../core/pay/rails/address', () => ({
  BRC29_PROTOCOL_ID: jest.requireActual('../../core/peerpay/brc29').BRC29_PROTOCOL_ID
}))

import { retryDelivery } from '../../core/pay/rails/handle'
import { OUTBOX_KEY, getOutboxEntries, saveOutboxEntry, type OutboxEntry } from '../../core/peerpay/outbox'
import { ADMIN, signedPayment } from '../__helpers__/signedPeerPay'

async function setup() {
  const values = new Map<string, string>()
  const storage = {
    getKeyValue: jest.fn(async (key: string) => values.get(key)),
    setKeyValue: jest.fn(async (key: string, value: string) => { values.set(key, value) })
  }
  await saveOutboxEntry(storage, await signedPayment())
  const [entry] = await getOutboxEntries(storage)
  storage.getKeyValue.mockClear()
  storage.setKeyValue.mockClear()
  const wallet = { createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: entry.txid, status: 'sending' }] }) }
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  return {
    storage, entry, wallet, client,
    replace: (rows: unknown[]) => values.set(OUTBOX_KEY, JSON.stringify(rows)),
    retry: (reviewed: OutboxEntry = entry) => retryDelivery({ wallet, client, storage, entry: reviewed, adminOriginator: ADMIN })
  }
}

it.each(['import_hold', 'sent', 'future_status'])('refuses a %s caller before any storage or delivery side effect', async status => {
  const f = await setup()
  await f.retry({ ...f.entry, status } as OutboxEntry)
  expect(f.storage.getKeyValue).not.toHaveBeenCalled()
  expect(f.storage.setKeyValue).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
  expect(f.wallet.createAction).not.toHaveBeenCalled()
})

it.each(['import_hold', 'sent', 'future_status', 'removed'])('re-reads a row changed to %s before delivery', async status => {
  const f = await setup()
  f.replace(status === 'removed' ? [] : [{ ...f.entry, status }])
  await f.retry()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
  expect(f.wallet.createAction).not.toHaveBeenCalled()
  expect(await getOutboxEntries(f.storage)).toEqual(status === 'removed' ? [] : [expect.objectContaining({ status })])
})

it('re-reads status after delivery and stops before broadcasting a newly held row', async () => {
  const f = await setup()
  f.client.sendMessage.mockImplementation(async () => { f.replace([{ ...f.entry, status: 'import_hold' }]) })
  await f.retry()
  expect(f.client.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.wallet.createAction).not.toHaveBeenCalled()
  expect((await getOutboxEntries(f.storage))[0].status).toBe('import_hold')
})

it('delivers an ordinary unsent signed payment, broadcasts its own txid and marks it sent', async () => {
  const f = await setup()
  await f.retry()
  expect(f.client.sendMessage).toHaveBeenCalledWith({
    recipient: f.entry.recipient, messageBox: 'payment_inbox', body: JSON.stringify(f.entry.token)
  }, undefined)
  expect(f.wallet.createAction).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sendWith: [f.entry.txid] }) }), ADMIN)
  expect((await getOutboxEntries(f.storage))[0].status).toBe('sent')
})

it('preserves legacy already-broadcast delivery without creating another action', async () => {
  const f = await setup()
  const entry = { ...f.entry, txid: undefined }
  f.replace([entry])
  await f.retry(entry)
  expect(f.client.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.wallet.createAction).not.toHaveBeenCalled()
  expect((await getOutboxEntries(f.storage))[0].status).toBe('sent')
})
