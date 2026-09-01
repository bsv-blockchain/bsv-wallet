import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { saveOutboxEntry } from '../../core/peerpay/outbox'
import {
  handleResendRequests,
  listPendingResendRequests,
  loadUnansweredResends,
  resendPaymentDetails
} from '../../core/peerpay/handleResendRequests'
import { PAYMENT_CONTROL_BOX } from '../../core/peerpay/control'

function atomicInboxToken() {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1000,
    lockingScript: LockingScript.fromHex('76a914000000000000000000000000000000000000000088ac')
  })
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return {
    txid,
    token: {
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      transaction: Array.from(beef.toBinaryAtomic(txid)),
      amount: 1000
    }
  }
}

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('handleResendRequests', () => {
  it('re-delivers a rebuilt token and acks the control message', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c1',
          sender: '02bb',
          body: { type: 'resend_request', txid: 'aa', reason: 'corrupt' }
        }
      ]),
      sendMessage,
      acknowledgeMessage
    }
    const storage = fakeStorage()
    await saveOutboxEntry(storage, {
      recipient: '02bb',
      token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 5 },
      messageBoxUrl: 'https://mb',
      txid: 'aa'
    })
    const r = await handleResendRequests({
      client: client as never,
      storage,
      listPeerPayAction: async () => undefined,
      refetch: async () => [8, 8, 8]
    })
    expect(r.resent).toBe(1)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ messageBox: 'payment_inbox', recipient: '02bb' }))
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c1'] })
  })

  it('lists the payment_control box and does not ack when send fails', async () => {
    const sendMessage = jest.fn().mockRejectedValue(new Error('offline'))
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c1',
          sender: '02bb',
          body: { type: 'resend_request', txid: 'aa', reason: 'corrupt' }
        }
      ]),
      sendMessage,
      acknowledgeMessage
    }
    const storage = fakeStorage()
    await saveOutboxEntry(storage, {
      recipient: '02bb',
      token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 5 },
      messageBoxUrl: 'https://mb',
      txid: 'aa'
    })
    const r = await handleResendRequests({
      client: client as never,
      storage,
      listPeerPayAction: async () => undefined,
      refetch: async () => [8, 8, 8]
    })
    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ messageBox: PAYMENT_CONTROL_BOX, acceptPayments: false })
    )
    expect(r.resent).toBe(0)
    expect(r.pending).toEqual([{ txid: 'aa', sender: '02bb' }])
    expect(acknowledgeMessage).not.toHaveBeenCalled()
    expect(await loadUnansweredResends(storage)).toEqual([{ txid: 'aa', sender: '02bb' }])
  })

  it('rebuilds from listPeerPayAction when the outbox has no match', async () => {
    const recipient = '02' + 'c'.repeat(64)
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c2',
          sender: recipient,
          body: { type: 'resend_request', txid: 'dd', reason: 'uncreditible' }
        }
      ]),
      sendMessage,
      acknowledgeMessage
    }
    const r = await handleResendRequests({
      client: client as never,
      storage: fakeStorage(),
      listPeerPayAction: async txid =>
        txid === 'dd'
          ? {
              txid: 'dd',
              labels: ['peerpay', recipient],
              outputs: [
                {
                  customInstructions: { derivationPrefix: 'x', derivationSuffix: 'y' },
                  satoshis: 9
                }
              ]
            }
          : undefined,
      refetch: async () => [3, 3]
    })
    expect(r.resent).toBe(1)
    expect(r.pending).toEqual([])
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageBox: 'payment_inbox', recipient })
    )
    expect(JSON.parse(sendMessage.mock.calls[0][0].body)).toMatchObject({
      customInstructions: { derivationPrefix: 'x', derivationSuffix: 'y' },
      transaction: [3, 3],
      amount: 9
    })
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c2'] })
  })

  // A nearby payment carries the same BRC-29 derivation data and the payee's
  // identity key, so it re-delivers through the message box exactly like a
  // handle payment — which is the only way to reach a payee whose session (and
  // therefore the sealed frame's key) is long gone.
  it('rebuilds a nearby (localpay) payment the same way as a handle payment', async () => {
    const recipient = '02' + 'd'.repeat(64)
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c9',
          sender: recipient,
          body: { type: 'resend_request', txid: 'near1', reason: 'uncreditible' }
        }
      ]),
      sendMessage,
      acknowledgeMessage: jest.fn().mockResolvedValue(undefined)
    }
    const r = await handleResendRequests({
      client: client as never,
      storage: fakeStorage(),
      listPeerPayAction: async txid =>
        txid === 'near1'
          ? {
              txid: 'near1',
              labels: ['localpay', recipient],
              outputs: [
                {
                  customInstructions: JSON.stringify({
                    derivationPrefix: 'np',
                    derivationSuffix: 'ns',
                    type: 'BRC29'
                  }),
                  satoshis: 777
                }
              ]
            }
          : undefined,
      refetch: async () => [7, 7]
    })
    expect(r.resent).toBe(1)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageBox: 'payment_inbox', recipient })
    )
    expect(JSON.parse(sendMessage.mock.calls[0][0].body)).toMatchObject({
      customInstructions: { derivationPrefix: 'np', derivationSuffix: 'ns' },
      transaction: [7, 7],
      amount: 777
    })
  })

  it('does not deliver a rebuilt token to the resend requester when the outbox and labels are missing', async () => {
    const sendMessage = jest.fn()
    const r = await handleResendRequests({
      client: {
        listMessages: async () => [
          {
            messageId: 'c1',
            sender: '02attacker',
            body: { type: 'resend_request', txid: 'aa'.repeat(32), reason: 'corrupt' }
          }
        ],
        acknowledgeMessage: jest.fn(),
        sendMessage
      } as never,
      storage: fakeStorage(),
      listPeerPayAction: async () => ({
        txid: 'aa'.repeat(32),
        labels: ['peerpay'],
        outputs: [{ customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, satoshis: 1 }]
      }),
      refetch: async () => [1]
    })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(r.pending).toEqual([{ txid: 'aa'.repeat(32), sender: '02attacker' }])
  })

  it('acks only after send succeeds', async () => {
    const order: string[] = []
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c1',
          sender: '02bb',
          body: { type: 'resend_request', txid: 'aa', reason: 'corrupt' }
        }
      ]),
      sendMessage: jest.fn(async () => {
        order.push('send')
      }),
      acknowledgeMessage: jest.fn(async () => {
        order.push('ack')
      })
    }
    const storage = fakeStorage()
    await saveOutboxEntry(storage, {
      recipient: '02bb',
      token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 5 },
      messageBoxUrl: 'https://mb',
      txid: 'aa'
    })
    await handleResendRequests({
      client: client as never,
      storage,
      listPeerPayAction: async () => undefined,
      refetch: async () => [8, 8, 8]
    })
    expect(order).toEqual(['send', 'ack'])
  })

  it('listPendingResendRequests persists rows without sending or acking', async () => {
    const sendMessage = jest.fn()
    const acknowledgeMessage = jest.fn()
    const storage = fakeStorage()
    const r = await listPendingResendRequests({
      client: {
        listMessages: jest.fn().mockResolvedValue([
          {
            messageId: 'c1',
            sender: '02bb',
            body: { type: 'resend_request', txid: 'aa', reason: 'corrupt' }
          }
        ]),
        sendMessage,
        acknowledgeMessage
      } as never,
      storage
    })
    expect(r.pending).toEqual([{ txid: 'aa', sender: '02bb' }])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(acknowledgeMessage).not.toHaveBeenCalled()
    expect(await loadUnansweredResends(storage)).toEqual([{ txid: 'aa', sender: '02bb' }])
  })

  it('leaves unparseable control messages untouched', async () => {
    const sendMessage = jest.fn()
    const acknowledgeMessage = jest.fn()
    const r = await handleResendRequests({
      client: {
        listMessages: jest.fn().mockResolvedValue([{ messageId: 'y', sender: '02aa', body: 'not json' }]),
        sendMessage,
        acknowledgeMessage
      } as never,
      storage: fakeStorage(),
      listPeerPayAction: async () => undefined,
      refetch: async () => [1]
    })
    expect(r).toEqual({ resent: 0, pending: [] })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('drops a matching payment_inbox token for payment_cancelled and acks the control message', async () => {
    const { txid, token } = atomicInboxToken()
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const listMessages = jest.fn(async ({ messageBox }: { messageBox: string }) => {
      if (messageBox === PAYMENT_CONTROL_BOX) {
        return [{ messageId: 'c1', sender: '02aa', body: { type: 'payment_cancelled', txid } }]
      }
      return [{ messageId: 'p1', sender: '02aa', body: token }]
    })
    const r = await listPendingResendRequests({
      client: { listMessages, acknowledgeMessage } as never,
      storage: fakeStorage()
    })
    expect(r.pending).toEqual([])
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['p1'] })
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c1'] })
    expect(acknowledgeMessage.mock.invocationCallOrder[0]).toBeLessThan(acknowledgeMessage.mock.invocationCallOrder[1])
  })

  it('does not drop an inbox token when payment_cancelled sender does not match the token sender', async () => {
    const { txid, token } = atomicInboxToken()
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const listMessages = jest.fn(async ({ messageBox }: { messageBox: string }) => {
      if (messageBox === PAYMENT_CONTROL_BOX) {
        return [{ messageId: 'c1', sender: '02ff', body: { type: 'payment_cancelled', txid } }]
      }
      return [{ messageId: 'p1', sender: '02aa', body: token }]
    })
    await listPendingResendRequests({
      client: { listMessages, acknowledgeMessage } as never,
      storage: fakeStorage()
    })
    expect(acknowledgeMessage).not.toHaveBeenCalledWith({ messageIds: ['p1'] })
    expect(acknowledgeMessage).not.toHaveBeenCalledWith({ messageIds: ['c1'] })
  })

  it('acks payment_cancelled even when the token is already gone from the inbox', async () => {
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const listMessages = jest.fn(async ({ messageBox }: { messageBox: string }) => {
      if (messageBox === PAYMENT_CONTROL_BOX) {
        return [{ messageId: 'c1', sender: '02aa', body: { type: 'payment_cancelled', txid: 'aa'.repeat(32) } }]
      }
      return []
    })
    await listPendingResendRequests({
      client: { listMessages, acknowledgeMessage } as never,
      storage: fakeStorage()
    })
    expect(acknowledgeMessage).toHaveBeenCalledTimes(1)
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c1'] })
  })

  it('does not ack payment_cancelled when dropping the inbox token fails', async () => {
    const { txid, token } = atomicInboxToken()
    const acknowledgeMessage = jest.fn(async ({ messageIds }: { messageIds: string[] }) => {
      if (messageIds.includes('p1')) throw new Error('offline')
    })
    const listMessages = jest.fn(async ({ messageBox }: { messageBox: string }) => {
      if (messageBox === PAYMENT_CONTROL_BOX) {
        return [{ messageId: 'c1', sender: '02aa', body: { type: 'payment_cancelled', txid } }]
      }
      return [{ messageId: 'p1', sender: '02aa', body: token }]
    })
    await listPendingResendRequests({
      client: { listMessages, acknowledgeMessage } as never,
      storage: fakeStorage()
    })
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['p1'] })
    expect(acknowledgeMessage).not.toHaveBeenCalledWith({ messageIds: ['c1'] })
  })
})

// Every failure used to reach the user as "Unknown error", which told someone
// whose payment can never be rebuilt to keep tapping a button that cannot work.
describe('resendPaymentDetails reasons', () => {
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  const base = {
    client: client as never,
    storage: fakeStorage(),
    txid: 'zz',
    refetch: async () => [1, 1] as number[]
  }

  it('reports no_record when nothing on this device knows the payment', async () => {
    const r = await resendPaymentDetails({ ...base, listPeerPayAction: async () => undefined })
    expect(r).toEqual({ ok: false, reason: 'no_record' })
  })

  it('reports no_recipient when the action never recorded who it was for', async () => {
    const r = await resendPaymentDetails({
      ...base,
      listPeerPayAction: async () => ({
        txid: 'zz',
        labels: ['peerpay'],
        outputs: [{ customInstructions: { derivationPrefix: 'a', derivationSuffix: 'b' }, satoshis: 5 }]
      })
    })
    expect(r).toEqual({ ok: false, reason: 'no_recipient' })
  })

  it('reports no_transaction when neither the network nor storage has the bytes', async () => {
    const r = await resendPaymentDetails({
      ...base,
      refetch: async () => undefined,
      listPeerPayAction: async () => ({
        txid: 'zz',
        labels: ['peerpay', '02' + 'a'.repeat(64)],
        outputs: [{ customInstructions: { derivationPrefix: 'a', derivationSuffix: 'b' }, satoshis: 5 }]
      })
    })
    expect(r).toEqual({ ok: false, reason: 'no_transaction' })
  })

  it('reports ok when the token is rebuilt and delivered', async () => {
    const r = await resendPaymentDetails({
      ...base,
      listPeerPayAction: async () => ({
        txid: 'zz',
        labels: ['peerpay', '02' + 'a'.repeat(64)],
        outputs: [{ customInstructions: { derivationPrefix: 'a', derivationSuffix: 'b' }, satoshis: 5 }]
      })
    })
    expect(r).toEqual({ ok: true })
  })
})
