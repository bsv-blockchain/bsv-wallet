/**
 * readBackupMaterial — what the "view/export my recovery material" screen
 * shows.
 *
 * A wallet has exactly one secret at a time (restoreWallet.ts's write order
 * guarantees that), so this never needs to reconcile two. The mnemonic wins
 * when present — it is the richer material (it also derives the vault key)
 * — and only when there is none does this fall back to the raw WIF, whose
 * hex form is what actually gets shown/exported as `text` (the WIF encoding
 * itself is still returned separately, for callers that need it as-is).
 *
 * `getRecoveredKey` is not even called once a mnemonic is found: an extra
 * secure-store read (and, on some platforms, a biometric prompt) for a value
 * that will not be used is a cost with no benefit.
 *
 * Neither secret present is not a recoverable state for this screen — it
 * throws rather than returning something the caller could render as if it
 * were valid.
 *
 * Does NOT decide who is allowed to call this, does not touch UI, i18n, or
 * navigation.
 */
import { PrivateKey } from '@bsv/sdk'
import { recoverMnemonicWallet } from '../mnemonicWallet'

export interface BackupMaterial {
  text: string
  mnemonic: string | null
  wif: string | null
  identityKey: string
}

export interface ReadBackupMaterialDeps {
  getMnemonic(): Promise<string | null>
  getRecoveredKey(): Promise<string | null>
}

export async function readBackupMaterial(deps: ReadBackupMaterialDeps): Promise<BackupMaterial> {
  const mnemonic = await deps.getMnemonic()
  if (mnemonic != null) {
    return {
      text: mnemonic,
      mnemonic,
      wif: null,
      identityKey: recoverMnemonicWallet(mnemonic).identityKey
    }
  }

  const wif = await deps.getRecoveredKey()
  if (wif != null) {
    const key = PrivateKey.fromWif(wif)
    return {
      text: key.toHex(),
      mnemonic: null,
      wif,
      identityKey: key.toPublicKey().toString()
    }
  }

  throw new Error('Wallet keys unavailable')
}
