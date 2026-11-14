/**
 * The chain check that runs before any YubiKey PIV reset (audit finding
 * reset-new-phone).
 *
 * The guards in pivReset.ts read local data only. On a phone that was restored
 * from the mnemonic they are all empty, so a card that already opens Vault
 * funds could be reset and its key destroyed. `checkVaultCardFunds` scans the
 * chain (read-only) and answers one of three things:
 *
 *  - `clear`: a complete scan found no record that names this card. It carries
 *    a short-lived clearance that `resetPivApplication` accepts.
 *  - `funds`: some record names this card. The app adopts the key
 *    (recoverVaultWithKey) and does not offer the reset.
 *  - `unknown`: the scan could not finish. This is never read as "no funds".
 *
 * A reset is still possible without a clearance, only with an explicit
 * `acknowledgeFundsLoss: true` from the owner.
 */
import { VAULT_RECOVERY_GAP_DEFAULT, scanVaultRecords, vaultGroupsOf, type VaultRecoveryGroup } from './chainRecovery'
import type { VaultChainLookup } from './markerLookup'
import type { VaultSaltChain } from './r1comb'
import type { VaultWallet } from './transfers'
import { issueResetClearance, type VaultResetClearance } from './resetClearance'
import { VaultError } from './types'
import { vaultStore } from './vaultStore'

export { VAULT_RESET_CLEARANCE_MS, isValidResetClearance, type VaultResetClearance } from './resetClearance'

export type VaultCardFunds =
  | { kind: 'clear'; serial: string; clearance: VaultResetClearance }
  | { kind: 'funds'; serial: string; deposits: number; satoshis: number; vaults: VaultRecoveryGroup[] }
  | { kind: 'unknown'; serial: string; reason: string; problems: number }

export async function checkVaultCardFunds(
  w: VaultWallet,
  adminOriginator: string,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  serial: string,
  gap: number = VAULT_RECOVERY_GAP_DEFAULT
): Promise<VaultCardFunds> {
  // Captured before the scan, so a wallet switch during it cannot be cleared.
  const storageKey = vaultStore.captureScopeToken().storageKey
  let scan: Awaited<ReturnType<typeof scanVaultRecords>>
  try {
    scan = await scanVaultRecords(w, adminOriginator, lookup, chain, gap)
  } catch (error) {
    const code = error instanceof VaultError ? error.code : 'chain-scan-failed'
    return { kind: 'unknown', serial, reason: code, problems: 0 }
  }
  if (scan.unknownIndexes.length > 0 || scan.problems.length > 0) {
    return {
      kind: 'unknown',
      serial,
      reason: scan.problems[0]?.reason ?? `lookup incomplete at index ${scan.unknownIndexes[0]}`,
      problems: scan.problems.length
    }
  }
  // Serial only: a reset changes the card's public key, the card stays the same.
  const names = (keys: readonly { serial: string }[]) => keys.some(k => k.serial === serial)
  const ready = scan.ready.filter(c => names(c.ci.keys))
  const pending = scan.pending.filter(ci => names(ci.keys))
  if (ready.length + pending.length > 0) {
    return {
      kind: 'funds',
      serial,
      deposits: ready.length + pending.length,
      satoshis: ready.reduce((sum, c) => sum + c.satoshis, 0),
      vaults: vaultGroupsOf(ready, pending)
    }
  }
  const clearance = issueResetClearance(serial, storageKey)
  return { kind: 'clear', serial, clearance }
}
