/**
 * Which kind of wallet is this, as far as Vault is concerned (audit finding
 * primary-key).
 *
 * A wallet restored from older key slices keeps a `recoveredKey` secret and has
 * no `mnemonic` secret. Vault needs the recovery phrase (R1: phrase plus any
 * one YubiKey), so it must not be set up on such a wallet.
 *
 * Rule: not allowed only when `recoveredKey` is present AND `mnemonic` is
 * absent. Both absent (tests, dev builds) is allowed. A keychain read error
 * fails closed.
 */
import { hasSecret } from '../secrets/store'
import { VaultError } from './types'

export type VaultSetupAvailability = { ok: true } | { ok: false; reason: 'no-mnemonic' }

export async function canSetUpVault(): Promise<VaultSetupAvailability> {
  let hasRecoveredKey: boolean
  let hasMnemonic: boolean
  try {
    hasRecoveredKey = await hasSecret('recoveredKey', { strict: true })
    hasMnemonic = await hasSecret('mnemonic', { strict: true })
  } catch {
    throw new VaultError('template-invalid', 'Could not read the wallet secret state')
  }
  if (hasRecoveredKey && !hasMnemonic) return { ok: false, reason: 'no-mnemonic' }
  return { ok: true }
}

export async function requireMnemonicWallet(): Promise<void> {
  const availability = await canSetUpVault()
  if (!availability.ok) {
    throw new VaultError('no-mnemonic', 'Vault needs a wallet made from a recovery phrase')
  }
}
