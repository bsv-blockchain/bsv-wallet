import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { atomicFromLocalBeef, makeResendBeef } from '../../core/peerpay/resendBeef'

/** A signed transaction with its source, as an unbroadcast nosend payment would be. */
function localBeef(): { beef: { toBinary(): number[] }; txid: string } {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
  tx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
  return { beef: { toBinary: () => tx.toBEEF() }, txid: tx.id('hex') }
}

describe('atomicFromLocalBeef', () => {
  // The payment this whole path exists for has no merkle proof: it was never
  // broadcast. Requiring one rejected it and told an online user their data
  // could not be fetched.
  it('accepts an unbroadcast transaction that carries its ancestry', () => {
    const { beef, txid } = localBeef()
    expect(atomicFromLocalBeef(beef, txid)).toBeTruthy()
  })

  it('refuses bytes that are not a beef', () => {
    expect(atomicFromLocalBeef({ toBinary: () => [1, 2, 3] }, 'aa')).toBeUndefined()
  })

  it('refuses a beef that does not name this txid', () => {
    const { beef } = localBeef()
    expect(atomicFromLocalBeef(beef, 'b'.repeat(64))).toBeUndefined()
  })
})

describe('makeResendBeef', () => {
  it('prefers the network answer, which carries a current proof', async () => {
    const storage = { getBeefForTransaction: jest.fn(), getValidBeefForKnownTxid: jest.fn() }
    const beef = await makeResendBeef({ refetch: async () => [9, 9, 9], storage })('abc')
    expect(beef).toEqual([9, 9, 9])
    expect(storage.getBeefForTransaction).not.toHaveBeenCalled()
  })

  it('falls back to local storage when the network has never seen the txid', async () => {
    const { beef, txid } = localBeef()
    const storage = { getBeefForTransaction: jest.fn().mockResolvedValue(beef) }
    expect(await makeResendBeef({ refetch: async () => undefined, storage })(txid)).toBeTruthy()
  })

  it('tries the known-txid lookup when the ancestry lookup throws', async () => {
    const { beef, txid } = localBeef()
    const storage = {
      getBeefForTransaction: jest.fn().mockRejectedValue(new Error('not known')),
      getValidBeefForKnownTxid: jest.fn().mockResolvedValue(beef)
    }
    expect(await makeResendBeef({ refetch: async () => undefined, storage })(txid)).toBeTruthy()
    expect(storage.getValidBeefForKnownTxid).toHaveBeenCalledWith(txid)
  })

  it('does not let a throwing network lookup skip the local fallback', async () => {
    const { beef, txid } = localBeef()
    const storage = { getBeefForTransaction: jest.fn().mockResolvedValue(beef) }
    const refetch = async () => {
      throw new Error('woc down')
    }
    expect(await makeResendBeef({ refetch, storage })(txid)).toBeTruthy()
  })

  it('is undefined when there is no network answer and no local copy', async () => {
    expect(await makeResendBeef({ refetch: async () => undefined, storage: null })('abc')).toBeUndefined()
  })
})
