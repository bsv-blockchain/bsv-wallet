/**
 * classifyImportInput / secretFromShares — the single place that turns raw user
 * input (or a recombined share set) into a WalletSecret with its identityKey
 * already computed, so every downstream orchestration module stays sdk-free.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import { classifyImportInput, secretFromShares } from '../../core/recovery/secret'
import { generateMnemonicWallet, recoverMnemonicWallet } from '../../core/mnemonicWallet'
import { generateEntropyShares, generateLegacyKeyShares } from '../../core/recovery/shares'

describe('classifyImportInput', () => {
  test('64 hex chars → wif secret with identity = its own public key', () => {
    const key = PrivateKey.fromRandom()
    const hex = key.toHex()
    const result = classifyImportInput(hex)
    expect(result).toEqual({
      kind: 'wif',
      wif: PrivateKey.fromHex(hex).toWif(),
      identityKey: key.toPublicKey().toString()
    })
  })

  test('uppercase hex is accepted', () => {
    const key = PrivateKey.fromRandom()
    const hex = key.toHex().toUpperCase()
    const result = classifyImportInput(hex)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('wif')
  })

  test('surrounding whitespace is trimmed', () => {
    const key = PrivateKey.fromRandom()
    const hex = key.toHex()
    const result = classifyImportInput(`  ${hex}\n`)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('wif')
  })

  test('a hex string PrivateKey.fromHex cannot parse → null, symmetric with the mnemonic branch', () => {
    const spy = jest.spyOn(PrivateKey, 'fromHex').mockImplementationOnce(() => {
      throw new Error('bad key')
    })
    try {
      expect(classifyImportInput('a'.repeat(64))).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  test('63 hex chars → null', () => {
    const key = PrivateKey.fromRandom()
    const short = key.toHex().slice(0, 63)
    expect(classifyImportInput(short)).toBeNull()
  })

  test('65 hex chars → null', () => {
    const key = PrivateKey.fromRandom()
    const long = key.toHex() + '0'
    expect(classifyImportInput(long)).toBeNull()
  })

  test('valid 12-word BIP39 phrase → mnemonic secret matching recoverMnemonicWallet', () => {
    const { mnemonic, identityKey } = generateMnemonicWallet()
    const result = classifyImportInput(mnemonic)
    expect(result).toEqual({ kind: 'mnemonic', mnemonic, identityKey })
    expect(result?.identityKey).toBe(recoverMnemonicWallet(mnemonic).identityKey)
  })

  test('garbage text → null', () => {
    expect(classifyImportInput('this is not a phrase or a key at all nope')).toBeNull()
  })

  test('empty string → null', () => {
    expect(classifyImportInput('')).toBeNull()
  })
})

describe('secretFromShares', () => {
  test('entropy shares recombine to a mnemonic secret matching the source wallet, legacy:false', () => {
    const { mnemonic, identityKey } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)
    const { secret, legacy } = secretFromShares(shares.slice(0, 2))
    expect(secret.kind).toBe('mnemonic')
    expect(secret.identityKey).toBe(identityKey)
    expect(legacy).toBe(false)
  })

  test('legacy key shares recombine to a wif secret, legacy:true', () => {
    const key = PrivateKey.fromRandom()
    const shares = generateLegacyKeyShares(key.toArray())
    const { secret, legacy } = secretFromShares(shares.slice(0, 2))
    expect(secret.kind).toBe('wif')
    expect(legacy).toBe(true)
    if (secret.kind === 'wif') {
      expect(secret.identityKey).toBe(key.toPublicKey().toString())
    }
  })

  test('mismatched/invalid shares throw', () => {
    expect(() => secretFromShares(['not', 'valid', 'shares'])).toThrow()
  })
})
