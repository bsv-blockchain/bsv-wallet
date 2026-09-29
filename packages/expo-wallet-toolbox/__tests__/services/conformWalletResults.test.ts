import { LockingScript, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import { conformWalletResults } from '../../core/services/conformWalletResults'

// @bsv/wallet-toolbox-mobile 2.14.3 returns two results @bsv/sdk 2.8.8+
// rejects in every dApp; bsv-blockchain/ts-stack fixes both in 2.14.4.

function signedAndUnsigned() {
  const source = new Transaction()
  source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
  const build = (unlock: string) => {
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex(unlock) })
    tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
    tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
    return tx
  }
  return { unsigned: build(''), signed: build('51') }
}

const ADMIN = 'admin.example'
const certifier = new PrivateKey(7).toPublicKey().toString()
const certificate = (index: number) => ({
  type: Utils.toBase64(Array(32).fill(1)),
  serialNumber: Utils.toBase64(Array(32).fill(index)),
  subject: new PrivateKey(100 + index).toPublicKey().toString(),
  certifier,
  revocationOutpoint: `${'ab'.repeat(32)}.${index}`,
  signature: '3006020101020101',
  fields: {},
  publiclyRevealedKeyring: {},
  decryptedFields: { userName: 'deggen' },
  certifierInfo: { name: 'Certifier', iconUrl: 'https://example.com/i.png', description: 'Test certifier', trust: 1 }
})

describe('conformWalletResults', () => {
  test('moves noSendChange onto the signed txid the permissions manager returns', async () => {
    const { unsigned, signed } = signedAndUnsigned()
    const manager = conformWalletResults(ADMIN, {
      createAction: async (_args: unknown, _originator?: string) => ({
        txid: signed.id('hex'),
        tx: signed.toAtomicBEEF(),
        noSendChange: [`${unsigned.id('hex')}.1`]
      })
    })
    const args = {
      description: 'Conformance no-send probe',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
      options: { noSend: true, acceptDelayedBroadcast: false }
    }
    const result = await manager.createAction(args as any, 'app.example')
    expect(result.noSendChange).toEqual([`${signed.id('hex')}.1`])
    expect(() => validateWalletResult('createAction', result, args)).not.toThrow()
  })

  test('leaves a signable createAction result alone', async () => {
    const { unsigned } = signedAndUnsigned()
    const created = {
      noSendChange: [`${unsigned.id('hex')}.1`],
      signableTransaction: { reference: 'cmVm', tx: unsigned.toAtomicBEEF() }
    }
    const manager = conformWalletResults(ADMIN, { createAction: async (_args: unknown, _originator?: string) => created })
    expect(await manager.createAction({} as any, 'app.example')).toEqual(created)
  })

  test.each(['discoverByAttributes', 'discoverByIdentityKey'] as const)(
    '%s returns the requested page and keeps the full total',
    async method => {
      const all = [1, 2, 3, 4].map(certificate)
      const manager = conformWalletResults(ADMIN, { [method]: async () => ({ totalCertificates: 4, certificates: all }) })
      const args =
        method === 'discoverByAttributes'
          ? { attributes: { userName: 'deggen' }, limit: 2, offset: 1 }
          : { identityKey: certificate(1).subject, limit: 2, offset: 1 }
      const result = await (manager as any)[method](args, 'app.example')
      expect(result).toEqual({ totalCertificates: 4, certificates: all.slice(1, 3) })
      if (method === 'discoverByAttributes') {
        expect(() => validateWalletResult(method, result, args)).not.toThrow()
      }
    }
  )

  test('applies the BRC-100 default limit of 10 when none is given', async () => {
    const all = Array.from({ length: 12 }, (_, i) => certificate(i + 1))
    const manager = conformWalletResults(ADMIN, {
      discoverByAttributes: async (_args: unknown, _originator?: string) => ({ totalCertificates: 12, certificates: all })
    })
    const result = await manager.discoverByAttributes({ attributes: { userName: 'deggen' } } as any, 'app.example')
    expect(result.certificates).toHaveLength(10)
    expect(result.totalCertificates).toBe(12)
  })

  test('passes every other method through bound to the manager', async () => {
    const manager = conformWalletResults(ADMIN, {
      secret: 42,
      getSecret(this: { secret: number }) {
        return this.secret
      }
    })
    expect(manager.getSecret()).toBe(42)
  })

  test('lets the originator abort its own signed no-send action by txid, and nobody else', async () => {
    const { signed } = signedAndUnsigned()
    const abortAction = jest.fn(async (_args: { reference: string }, _originator?: string) => ({ aborted: true }))
    const manager = conformWalletResults(ADMIN, {
      createAction: async (_args: unknown, _originator?: string) => ({ txid: signed.id('hex'), tx: signed.toAtomicBEEF() }),
      abortAction
    })
    const { txid } = await manager.createAction({ options: { noSend: true } } as any, 'app.example')

    await expect(manager.abortAction({ reference: txid! }, 'other.example')).rejects.toThrow('different originator')
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).resolves.toEqual({ aborted: true })
    // The 2.14.3 permissions manager only lets the admin abort a signed no-send action.
    expect(abortAction).toHaveBeenCalledWith({ reference: txid }, ADMIN)
    // Released once; afterwards the reference goes through the manager's own check.
    await manager.abortAction({ reference: txid! }, 'app.example')
    expect(abortAction).toHaveBeenLastCalledWith({ reference: txid }, 'app.example')
  })

  test('never elevates an abort for an action that was broadcast', async () => {
    const { signed } = signedAndUnsigned()
    const abortAction = jest.fn(async (_args: { reference: string }, _originator?: string) => ({ aborted: false }))
    const manager = conformWalletResults(ADMIN, {
      createAction: async (_args: unknown, _originator?: string) => ({ txid: signed.id('hex'), tx: signed.toAtomicBEEF() }),
      abortAction
    })
    const { txid } = await manager.createAction({} as any, 'app.example')
    await manager.abortAction({ reference: txid! }, 'app.example')
    expect(abortAction).toHaveBeenCalledWith({ reference: txid }, 'app.example')
  })
})
