import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { internalizeAction } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/internalizeAction'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { buildLock, commitment } from '../../core/services/vault/r1comb'

const TXID = 'ab'.repeat(32)

describe('stored output ownership invariants', () => {
  it('rejects an authenticated R1C source at the storage boundary without host admin authorization', async () => {
    const pubkey = '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'
    const salt = '11'.repeat(32)
    const lock = buildLock({ commitments: [commitment(pubkey, salt)], saltHex64: salt })
    const storage = Object.create(StorageExpoSQLite.prototype) as StorageExpoSQLite

    await expect(storage.validateResolvedActionInput(
      { __bsvVaultAdminAuthorized: false },
      { lockingScript: lock }
    )).rejects.toThrow(/internal wallet authorization/i)
    await expect(storage.validateResolvedActionInput(
      { __bsvVaultAdminAuthorized: true },
      { lockingScript: lock }
    )).resolves.toBeUndefined()
  })

  it('does not apply the Vault policy to a non-R1C source script', async () => {
    const storage = Object.create(StorageExpoSQLite.prototype) as StorageExpoSQLite
    await expect(storage.validateResolvedActionInput(
      { __bsvVaultAdminAuthorized: false },
      { lockingScript: LockingScript.fromHex('51') }
    )).resolves.toBeUndefined()
  })

  it('relinquishOutput verifies the output actual basket inside one transaction', async () => {
    const updateOutput = jest.fn()
    const trx = { id: 'trx' }
    const storage = {
      transaction: jest.fn(async (fn: (token: unknown) => unknown) => await fn(trx)),
      findOutputs: jest.fn(async () => [{ outputId: 7, basketId: 2 }]),
      findOutputBaskets: jest.fn(async () => [{ basketId: 1, name: 'ordinary' }]),
      updateOutput
    }

    await expect(StorageProvider.prototype.relinquishOutput.call(
      storage,
      { userId: 1 },
      { basket: 'ordinary', output: `${TXID}.0` }
    )).rejects.toThrow(/basket/i)
    expect(updateOutput).not.toHaveBeenCalled()
    expect(storage.findOutputs).toHaveBeenCalledWith(expect.objectContaining({ trx }))
    expect(storage.findOutputBaskets).toHaveBeenCalledWith(expect.objectContaining({ trx }))
  })

  it('relinquishOutput removes an output only when the stored basket matches', async () => {
    const updateOutput = jest.fn(async () => 1)
    const trx = { id: 'trx' }
    const storage = {
      transaction: jest.fn(async (fn: (token: unknown) => unknown) => await fn(trx)),
      findOutputs: jest.fn(async () => [{ outputId: 7, basketId: 2 }]),
      findOutputBaskets: jest.fn(async () => [{ basketId: 2, name: 'ordinary' }]),
      updateOutput
    }

    await expect(StorageProvider.prototype.relinquishOutput.call(
      storage,
      { userId: 1 },
      { basket: 'ordinary', output: `${TXID}.0` }
    )).resolves.toBe(1)
    expect(updateOutput).toHaveBeenCalledWith(7, { basketId: undefined }, trx)
  })

  it('internalizeAction cannot move an existing custom output to another basket', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const storage = {
      getServices: () => ({ getChainTracker: jest.fn(async () => ({})) }),
      findOutputBaskets: jest.fn(async ({ partial }: any) => {
        if (partial.name === 'default') return [{ basketId: 1, userId: 1, name: 'default' }]
        if (partial.basketId === 2) return [{ basketId: 2, userId: 1, name: 'admin vault' }]
        return []
      }),
      findTransactions: jest.fn(async () => [{
        transactionId: 3,
        userId: 1,
        txid: tx.id('hex'),
        status: 'completed',
        satoshis: 0
      }]),
      findOutputs: jest.fn(async () => [{
        outputId: 7,
        transactionId: 3,
        userId: 1,
        txid: tx.id('hex'),
        vout: 0,
        basketId: 2,
        satoshis: 1,
        type: 'custom',
        change: false,
        providedBy: 'you',
        purpose: '',
        spendable: true
      }]),
      updateOutput: jest.fn()
    }
    const verify = jest.spyOn(Beef.prototype, 'verify').mockResolvedValue(true)
    try {
      await expect(internalizeAction(storage as never, { userId: 1 } as never, {
        tx: beef.toBinaryAtomic(tx.id('hex')),
        description: 'Try moving protected output',
        labels: [],
        outputs: [{
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'ordinary' }
        }]
      })).rejects.toThrow(/cannot be reclassified/i)
      expect(storage.updateOutput).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
    }
  })

})
