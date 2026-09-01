import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
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

describe('the transaction row as a last resort', () => {
  /** rawTx plus the ancestry column, as `createAction` writes them. */
  function storedRow() {
    const key = PrivateKey.fromRandom()
    const source = new Transaction()
    source.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(key.toPublicKey().toHash())
    })
    tx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toPublicKey().toHash()) })
    const inputBEEF = new Beef()
    inputBEEF.mergeRawTx(source.toBinary())
    return { rawTx: tx.toBinary(), inputBEEF: inputBEEF.toBinary(), txid: tx.id('hex') }
  }

  // Both ancestry lookups walk the input chain by asking storage for each
  // ancestor txid, and throw on the first one they do not hold. A parked
  // payment is exactly the case where that walk can fail on a transaction this
  // device holds in full.
  it('answers from rawTx and inputBEEF when both ancestry lookups fail', async () => {
    const { rawTx, inputBEEF, txid } = storedRow()
    const storage = {
      getBeefForTransaction: jest.fn().mockRejectedValue(new Error('ancestor not known')),
      getValidBeefForKnownTxid: jest.fn().mockRejectedValue(new Error('ancestor not known')),
      findTransactions: jest.fn().mockResolvedValue([{ rawTx, inputBEEF }])
    }
    expect(await makeResendBeef({ refetch: async () => undefined, storage })(txid)).toBeTruthy()
  })

  it('stays undefined when the row has no transaction bytes', async () => {
    const storage = {
      getBeefForTransaction: jest.fn().mockRejectedValue(new Error('nope')),
      findTransactions: jest.fn().mockResolvedValue([{ rawTx: null, inputBEEF: null }])
    }
    expect(await makeResendBeef({ refetch: async () => undefined, storage })('aa'.repeat(32))).toBeUndefined()
  })
})
