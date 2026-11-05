import { handleResendRequests, resendPaymentDetails } from '../../core/peerpay/handleResendRequests'
import {
  OUTBOX_KEY,
  getOutboxEntries,
  quarantineImportedOutbox,
  releaseImportedOutboxEntry,
  saveOutboxEntry
} from '../../core/peerpay/outbox'
import { ADMIN, sender, signedPayment } from '../__helpers__/signedPeerPay'

async function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getKeyValue: async (key: string) => values.get(key),
    setKeyValue: async (key: string, value: string) => {
      values.set(key, value)
    }
  }
  const payment = await signedPayment()
  await saveOutboxEntry(storage, payment)
  await quarantineImportedOutbox(storage)
  const [held] = await getOutboxEntries(storage)
  const client = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    listMessages: jest.fn().mockResolvedValue([
      {
        messageId: 'request',
        sender: held.recipient,
        body: { type: 'resend_request', txid: held.txid, reason: 'corrupt' }
      }
    ]),
    acknowledgeMessage: jest.fn().mockResolvedValue(undefined)
  }
  const listPeerPayAction = jest.fn().mockResolvedValue({
    txid: held.txid,
    labels: ['peerpay', held.recipient],
    outputs: [{ customInstructions: held.token.customInstructions, satoshis: held.token.amount }]
  })
  const refetch = jest.fn().mockResolvedValue(held.token.transaction)
  return { storage, held, client, listPeerPayAction, refetch }
}

test('a held activity resend cannot fetch, fall back to action metadata, or deliver', async () => {
  const f = await fixture()
  await expect(resendPaymentDetails({ ...f, txid: f.held.txid! })).rejects.toThrow(/review/i)
  expect(f.listPeerPayAction).not.toHaveBeenCalled()
  expect(f.refetch).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
  expect(await getOutboxEntries(f.storage)).toEqual([f.held])
})

test('a pending resend request remains pending while the payment is held', async () => {
  const f = await fixture()
  await expect(handleResendRequests(f)).resolves.toEqual({
    resent: 0,
    pending: [{ txid: f.held.txid, sender: f.held.recipient }]
  })
  expect(f.refetch).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
  expect(f.client.acknowledgeMessage).not.toHaveBeenCalled()
  expect(await getOutboxEntries(f.storage)).toEqual([f.held])
})

test('another historical row for the same transaction cannot hide its import hold', async () => {
  const f = await fixture()
  await f.storage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...f.held, id: 'sent-copy', status: 'sent' }, f.held]))
  await expect(resendPaymentDetails({ ...f, txid: f.held.txid! })).rejects.toThrow(/review/i)
  expect(f.refetch).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
})

test.each([undefined, 'ab'.repeat(32)])('held token bytes retain the hold when stored txid is %s', async txid => {
  const f = await fixture()
  await f.storage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...f.held, txid }]))
  await expect(resendPaymentDetails({ ...f, txid: f.held.txid! })).rejects.toThrow(/review/i)
  expect(f.listPeerPayAction).not.toHaveBeenCalled()
  expect(f.refetch).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
})

test.each(['unreadable', 'malformed'] as const)('a %s outbox cannot fall back around a hold', async fault => {
  const f = await fixture()
  if (fault === 'unreadable')
    f.storage.getKeyValue = async () => {
      throw new Error('storage unavailable')
    }
  else await f.storage.setKeyValue(OUTBOX_KEY, '{bad')
  await expect(resendPaymentDetails({ ...f, txid: f.held.txid! })).rejects.toThrow()
  expect(f.listPeerPayAction).not.toHaveBeenCalled()
  expect(f.refetch).not.toHaveBeenCalled()
  expect(f.client.sendMessage).not.toHaveBeenCalled()
})

test.each(['unsent', 'sent'] as const)('a reviewed payment remains resendable after becoming %s', async status => {
  const f = await fixture()
  const approved = await releaseImportedOutboxEntry(f.storage, f.held, sender, ADMIN)
  await f.storage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...approved, status }]))
  await expect(resendPaymentDetails({ ...f, txid: f.held.txid! })).resolves.toEqual({ ok: true })
  expect(f.client.sendMessage).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.client.sendMessage.mock.calls[0][0].body).transaction).toEqual(f.held.token.transaction)
})
