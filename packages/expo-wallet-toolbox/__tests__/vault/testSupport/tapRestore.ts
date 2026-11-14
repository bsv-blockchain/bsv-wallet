import { recoverVaultWithKey, type VaultRestoreOptions } from '../../../core/services/vault/chainRecovery'
import type { VaultChainLookup } from '../../../core/services/vault/markerLookup'
import type { VaultInstructionKey, VaultSaltChain } from '../../../core/services/vault/r1comb'
import { computeVaultMetaAuthorityTag } from '../../../core/services/vault/metaAuthority'
import { vaultStore } from '../../../core/services/vault/vaultStore'
import type { FakeVaultWallet } from './fakeVaultChain'
import { ADMIN } from './publishVault'

/** A restore with a tap of `key` (the card is replaced by a callback that returns the key). */
export const tapRestore = (
  w: FakeVaultWallet,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  key: VaultInstructionKey,
  options?: VaultRestoreOptions
) => recoverVaultWithKey(w, ADMIN, lookup, chain, async () => key, undefined, options)

/** The state a 0.24.x no-tap restore left: meta and outputs restored, `recovery.required`, NOTHING adopted.
 * Built by a tapped restore, then forgetting the setup and restoring the same meta with an empty `adopted`. */
export async function restoreNothingAdopted(
  w: FakeVaultWallet,
  lookup: VaultChainLookup,
  chain: VaultSaltChain,
  key: VaultInstructionKey
): Promise<void> {
  await tapRestore(w, lookup, chain, key)
  const meta = (await vaultStore.getMeta())!
  await vaultStore.forgetSetup()
  const scope = vaultStore.getScope()!
  const { recovery: _drop, ...bare } = meta
  await vaultStore.restoreVerifiedMeta(bare, undefined, next => computeVaultMetaAuthorityTag(w, ADMIN, next, scope))
}
