/**
 * Profile key derivation: profile n's identity is m/0'/n' and its privileged
 * key is m/1'/n', both from the one seed every profile shares.
 */
import { HD, Mnemonic } from '@bsv/sdk'
import {
  deriveProfileKeys,
  hdFromMnemonic,
  profilePaths,
  recoverMnemonicWallet
} from '../../core/mnemonicWallet'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hd = HD.fromSeed(Mnemonic.fromString(MNEMONIC).toSeed(''))
const at = (path: string) => hd.derive(path).privKey

describe('profile derivation', () => {
  test('paths', () => {
    expect(profilePaths(0)).toEqual({ primary: "m/0'/0'", privileged: "m/1'/0'" })
    expect(profilePaths(3)).toEqual({ primary: "m/0'/3'", privileged: "m/1'/3'" })
  })

  test('profile 0 identity is m/0\'/0\', privileged m/1\'/0\'', () => {
    const w = recoverMnemonicWallet(MNEMONIC)
    expect(w.primaryKey).toEqual(at("m/0'/0'").toArray())
    expect(w.identityKey).toBe(at("m/0'/0'").toPublicKey().toString())
    expect(w.privilegedKey.toHex()).toBe(at("m/1'/0'").toHex())
  })

  test('profile 1 identity is m/0\'/1\', privileged m/1\'/1\'', () => {
    const w = recoverMnemonicWallet(MNEMONIC, '', 1)
    expect(w.primaryKey).toEqual(at("m/0'/1'").toArray())
    expect(w.privilegedKey.toHex()).toBe(at("m/1'/1'").toHex())
  })

  test('no two keys coincide across or within profiles', () => {
    const a = recoverMnemonicWallet(MNEMONIC, '', 0)
    const b = recoverMnemonicWallet(MNEMONIC, '', 1)
    const hexes = [a.privilegedKey.toHex(), b.privilegedKey.toHex(), Buffer.from(a.primaryKey).toString('hex'), Buffer.from(b.primaryKey).toString('hex')]
    expect(new Set(hexes).size).toBe(4)
    expect(a.identityKey).not.toBe(b.identityKey)
  })

  test('the BIP32 master key is never returned', () => {
    const w = recoverMnemonicWallet(MNEMONIC)
    expect((w as unknown as Record<string, unknown>).rootKey).toBeUndefined()
    expect(w.privilegedKey.toHex()).not.toBe(hd.privKey.toHex())
  })

  test('deriveProfileKeys works from a pre-built HD (one PBKDF2 for many profiles)', () => {
    const root = hdFromMnemonic(MNEMONIC)
    expect(deriveProfileKeys(root, 2).identityKey).toBe(at("m/0'/2'").toPublicKey().toString())
    expect(deriveProfileKeys(root, 2)).toEqual(
      expect.objectContaining({ identityKey: recoverMnemonicWallet(MNEMONIC, '', 2).identityKey })
    )
  })

  test.each([-1, 1.5, Number.NaN, 2 ** 31])('rejects invalid profile index %p', n => {
    expect(() => profilePaths(n)).toThrow()
  })
})
