/**
 * readBackupMaterial — assembles what the export/backup screen shows: the
 * mnemonic if there is one, else the WIF hex, never both.
 */
import { PrivateKey } from '@bsv/sdk'
import { readBackupMaterial } from '../../core/recovery/backupMaterial'
import { generateMnemonicWallet, recoverMnemonicWallet } from '../../core/mnemonicWallet'

function deps(overrides: { mnemonic?: string | null; wif?: string | null } = {}) {
  const getMnemonic = jest.fn(async () => overrides.mnemonic ?? null)
  const getRecoveredKey = jest.fn(async () => overrides.wif ?? null)
  return { getMnemonic, getRecoveredKey }
}

describe('readBackupMaterial', () => {
  test('mnemonic present → text/mnemonic = phrase, wif null, identity derived from it', async () => {
    const { mnemonic, identityKey } = generateMnemonicWallet()
    const d = deps({ mnemonic })
    const result = await readBackupMaterial(d)
    expect(result.text).toBe(mnemonic)
    expect(result.mnemonic).toBe(mnemonic)
    expect(result.wif).toBeNull()
    expect(result.identityKey).toBe(recoverMnemonicWallet(mnemonic).identityKey)
    expect(result.identityKey).toBe(identityKey)
  })

  test('mnemonic null, wif present → text = hex, wif = the wif, mnemonic null, identity = pubkey', async () => {
    const key = PrivateKey.fromRandom()
    const wif = key.toWif()
    const d = deps({ mnemonic: null, wif })
    const result = await readBackupMaterial(d)
    expect(result.text).toBe(key.toHex())
    expect(result.wif).toBe(wif)
    expect(result.mnemonic).toBeNull()
    expect(result.identityKey).toBe(key.toPublicKey().toString())
  })

  test('neither present → rejects with Error("Wallet keys unavailable")', async () => {
    const d = deps({ mnemonic: null, wif: null })
    await expect(readBackupMaterial(d)).rejects.toThrow('Wallet keys unavailable')
  })

  test('getRecoveredKey not called when a mnemonic exists', async () => {
    const { mnemonic } = generateMnemonicWallet()
    const d = deps({ mnemonic })
    await readBackupMaterial(d)
    expect(d.getRecoveredKey).not.toHaveBeenCalled()
  })
})
