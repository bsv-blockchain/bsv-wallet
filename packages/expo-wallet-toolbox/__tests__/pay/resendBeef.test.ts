import { makeResendBeef } from '../../core/peerpay/resendBeef'

describe('makeResendBeef', () => {
  it('prefers the network answer, which carries a current proof', async () => {
    const storage = { getValidBeefForKnownTxid: jest.fn() }
    const refetch = jest.fn().mockResolvedValue([9, 9, 9])
    const beef = await makeResendBeef({ refetch, storage })('abc')
    expect(beef).toEqual([9, 9, 9])
    expect(storage.getValidBeefForKnownTxid).not.toHaveBeenCalled()
  })

  // The payment a resend most needs to cover: a nearby code that was never
  // scanned was never broadcast, so no service has heard of the transaction.
  it('falls back to local storage when the network has never seen the txid', async () => {
    const storage = {
      getValidBeefForKnownTxid: jest.fn().mockResolvedValue({ toBinary: () => [1, 2, 3] })
    }
    const beef = await makeResendBeef({ refetch: async () => undefined, storage })('abc')
    // [1,2,3] is not a parseable Beef, so the structural bar rejects it rather
    // than shipping bytes the payee's wallet would refuse.
    expect(beef).toBeUndefined()
    expect(storage.getValidBeefForKnownTxid).toHaveBeenCalledWith('abc')
  })

  it('is undefined when there is no network answer and no local copy', async () => {
    const beef = await makeResendBeef({ refetch: async () => undefined, storage: null })('abc')
    expect(beef).toBeUndefined()
  })

  it('does not let a throwing network lookup skip the local fallback', async () => {
    const storage = {
      getValidBeefForKnownTxid: jest.fn().mockResolvedValue({ toBinary: () => [] })
    }
    await makeResendBeef({
      refetch: async () => {
        throw new Error('woc down')
      },
      storage
    })('abc')
    expect(storage.getValidBeefForKnownTxid).toHaveBeenCalled()
  })

  it('survives a storage read that throws', async () => {
    const storage = {
      getValidBeefForKnownTxid: jest.fn().mockRejectedValue(new Error('no beef'))
    }
    await expect(makeResendBeef({ refetch: async () => undefined, storage })('abc')).resolves.toBeUndefined()
  })
})
