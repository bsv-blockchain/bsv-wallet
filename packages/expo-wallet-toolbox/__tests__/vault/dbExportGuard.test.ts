import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import { guardVaultAccess, VaultAccessDenied } from '../../core/services/vault/guard'
import { DB_EXPORT_KEY_ID, DB_EXPORT_PROTOCOL } from '../../core/storage/encryptedDbImage'

const ADMIN = 'admin.com'

function fakeWallet() {
  const calls: unknown[] = []
  const methods = [
    'getPublicKey',
    'encrypt',
    'decrypt',
    'createHmac',
    'verifyHmac',
    'createSignature',
    'verifySignature',
    'revealSpecificKeyLinkage',
    'revealCounterpartyKeyLinkage'
  ]
  const wallet = Object.fromEntries(
    methods.map(method => [
      method,
      async (args: unknown, originator: string) => {
        calls.push({ method, args, originator })
        return {}
      }
    ])
  ) as any
  return { wallet, calls }
}

test.each([
  'getPublicKey',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'revealSpecificKeyLinkage',
  'revealCounterpartyKeyLinkage'
] as const)('reserves database export keys from external %s calls', async method => {
  for (const protocolID of [
    [2, 'wallet db export'],
    [2, ' WALLET DB EXPORT '],
    [2, 'wallet db export', 'extra']
  ]) {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    const args = { protocolID, keyID: '1', counterparty: 'self', data: [1], ciphertext: [1] }
    await expect((guarded[method] as any)(args, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls).toEqual([])
    await (guarded[method] as any)(args, ADMIN)
    expect(calls).toEqual([{ method, args, originator: ADMIN }])
  }
})

test('admin export wrapping still round-trips while external header decryption is refused', async () => {
  // This unit exercises only encrypt/decrypt on the real SDK implementation.
  // ProtoWallet omits action/storage methods required by the full guard API.
  const cryptoWallet = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface
  const guarded = guardVaultAccess(cryptoWallet, ADMIN)
  const tuple = { protocolID: DB_EXPORT_PROTOCOL, keyID: DB_EXPORT_KEY_ID, counterparty: 'self' }
  const plaintext = [1, 2, 3, 4]
  const { ciphertext } = await guarded.encrypt({ ...tuple, plaintext }, ADMIN)
  await expect(guarded.decrypt({ ...tuple, ciphertext }, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  await expect(guarded.decrypt({ ...tuple, ciphertext }, ADMIN)).resolves.toMatchObject({ plaintext })
})
