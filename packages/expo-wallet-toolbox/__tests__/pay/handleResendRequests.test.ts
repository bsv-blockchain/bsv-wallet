import { saveOutboxEntry } from '../../core/peerpay/outbox'
import { handleResendRequests, loadUnansweredResends } from '../../core/peerpay/handleResendRequests'
import { PAYMENT_CONTROL_BOX } from '../../core/peerpay/control'

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
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
    const client = {
      listMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'c2',
          sender: '02cc',
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
              labels: ['peerpay', '02cc'],
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
      expect.objectContaining({
        messageBox: 'payment_inbox',
        recipient: '02cc',
        body: JSON.stringify({
          customInstructions: { derivationPrefix: 'x', derivationSuffix: 'y' },
          transaction: [3, 3],
          amount: 9
        })
      })
    )
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c2'] })
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

  it('leaves non-resend control messages untouched', async () => {
    const sendMessage = jest.fn()
    const acknowledgeMessage = jest.fn()
    const r = await handleResendRequests({
      client: {
        listMessages: jest.fn().mockResolvedValue([
          { messageId: 'x', sender: '02aa', body: { type: 'payment_cancelled', txid: 'zz' } },
          { messageId: 'y', sender: '02aa', body: 'not json' }
        ]),
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
})
