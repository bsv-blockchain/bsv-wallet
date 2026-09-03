import { nackRejectedReceived, OFFLINE_NACKS_KEY, sendBouncedOfflineNack } from '../../core/peerpay/offlineNacks'

function fakeStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v),
    map
  }
}

describe('sendBouncedOfflineNack', () => {
  it('sends resend_request with bounced_offline once and records nackSentAt', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const storage = fakeStorage()
    const first = await sendBouncedOfflineNack({
      client: { sendMessage },
      storage,
      txid: 'aa',
      recipient: '02sender'
    })
    const second = await sendBouncedOfflineNack({
      client: { sendMessage },
      storage,
      txid: 'aa',
      recipient: '02sender'
    })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      {
        recipient: '02sender',
        messageBox: 'payment_control',
        body: JSON.stringify({ type: 'resend_request', txid: 'aa', reason: 'bounced_offline' })
      },
      undefined // no host override on this path
    )
    const stored = JSON.parse((await storage.getKeyValue(OFFLINE_NACKS_KEY)) ?? '{}') as {
      aa?: { nackSentAt: number }
    }
    expect(typeof stored.aa?.nackSentAt).toBe('number')
  })

  it('force re-sends even after a recorded nack', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const storage = fakeStorage()
    await sendBouncedOfflineNack({ client: { sendMessage }, storage, txid: 'aa', recipient: '02sender' })
    const again = await sendBouncedOfflineNack({
      client: { sendMessage },
      storage,
      txid: 'aa',
      recipient: '02sender',
      force: true
    })
    expect(again).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})

describe('nackRejectedReceived', () => {
  it('nacks received rows that have a sender and skips the rest', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const storage = fakeStorage()
    await nackRejectedReceived({
      client: { sendMessage },
      storage,
      rows: [
        { txid: 'aa', senderIdentityKey: '02aa' },
        { txid: 'bb', senderIdentityKey: null }
      ]
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: '02aa',
        body: JSON.stringify({ type: 'resend_request', txid: 'aa', reason: 'bounced_offline' })
      }),
      undefined // no host override on this path
    )
  })
})

