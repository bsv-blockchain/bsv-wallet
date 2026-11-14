/** Fresh hardware authority for new funds. A valid root MAC proves that an
 * enrollment was once approved, but cannot distinguish a retired enrollment
 * replayed from storage. R1C is 1-of-N: prove one key that the new lock commits
 * to, for this exact output, before any funding action is created. */
import { Hash, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { requestVaultSigner } from './ceremonyHost'
import { randomBytes } from './random'
import { VaultError } from './types'
import { vaultStore, type VaultMeta, type VaultScopeToken } from './vaultStore'

interface VaultOutputAuthorityContext {
  satoshis: number
  saltKeyId: string
  lockingScript: string
}

export async function requireVaultOutputKeyPossession(
  meta: Pick<VaultMeta, 'vaultId' | 'revision' | 'createdAt' | 'keys' | 'lastUsedSerial'>,
  scope: VaultScopeToken,
  output: VaultOutputAuthorityContext,
  chosenSerial?: string
): Promise<void> {
  vaultStore.assertScopeToken(scope)
  const chosen =
    chosenSerial !== undefined
      ? meta.keys.find(key => key.serial === chosenSerial)
      : (meta.keys.find(key => key.serial === meta.lastUsedSerial) ?? meta.keys[0])
  if (!chosen) throw new VaultError('not-enrolled', 'Choose a key committed to the new vault output')
  const digest = Hash.sha256(
    Utils.toArray(
      JSON.stringify({
        v: 1,
        kind: 'vault-new-output',
        walletScope: scope.storageKey,
        chain: scope.chain,
        vaultId: meta.vaultId,
        revision: meta.revision,
        createdAt: meta.createdAt,
        keys: meta.keys.map(key => ({ serial: key.serial, slot: key.slot, pubkey: key.pubkey })),
        satoshis: output.satoshis,
        saltKeyId: output.saltKeyId,
        lockingScriptHash: Utils.toHex(Hash.sha256(Utils.toArray(output.lockingScript, 'hex'))),
        nonce: Utils.toHex(randomBytes(32))
      }),
      'utf8'
    )
  )
  await proveKeyPossession(scope, chosen, digest, 'Verify vault key for new funds')
}

/** Fresh hardware authority to promote a staged key (add-key, late-key) when
 * no funded output exists to re-lock. Same flow as requireVaultOutputKeyPossession:
 * the chosen existing key signs a digest that binds the vault, its current
 * revision and key list, the staged pubkey, the new revision and a nonce. */
export async function requireVaultKeyChallenge(
  meta: Pick<VaultMeta, 'vaultId' | 'revision' | 'createdAt' | 'keys' | 'lastUsedSerial'>,
  scope: VaultScopeToken,
  challenge: { kind: 'vault-add-key'; stagedPubkey: string; newRevision: number },
  chosenSerial: string
): Promise<void> {
  vaultStore.assertScopeToken(scope)
  const chosen = meta.keys.find(key => key.serial === chosenSerial)
  if (!chosen) throw new VaultError('not-enrolled', 'Choose a key that is already part of the vault')
  const digest = Hash.sha256(
    Utils.toArray(
      JSON.stringify({
        v: 1,
        kind: challenge.kind,
        walletScope: scope.storageKey,
        chain: scope.chain,
        vaultId: meta.vaultId,
        revision: meta.revision,
        createdAt: meta.createdAt,
        keys: meta.keys.map(key => ({ serial: key.serial, slot: key.slot, pubkey: key.pubkey })),
        stagedPubkey: challenge.stagedPubkey,
        newRevision: challenge.newRevision,
        nonce: Utils.toHex(randomBytes(32))
      }),
      'utf8'
    )
  )
  await proveKeyPossession(scope, chosen, digest, 'Verify vault key to add a new key')
}

/** Ask the chosen key's card to sign `digest` and verify the P-256 signature
 * against the stored pubkey. */
async function proveKeyPossession(
  scope: VaultScopeToken,
  chosen: VaultMeta['keys'][number],
  digest: number[],
  reason: string
): Promise<void> {
  const signer = await requestVaultSigner(reason, chosen.serial)
  try {
    vaultStore.assertScopeToken(scope)
    if (signer.serial !== chosen.serial || signer.pubkey !== chosen.pubkey) {
      throw new VaultError('wrong-key', 'Hardware does not match the new vault output key')
    }
    const signature = await signer.sign(Utils.toHex(digest))
    vaultStore.assertScopeToken(scope)
    let valid = false
    try {
      const der = p256.Signature.fromBytes(Uint8Array.from(signature), 'der')
      valid = p256.verify(
        der.toBytes(),
        Uint8Array.from(digest),
        Uint8Array.from(Utils.toArray(chosen.pubkey, 'hex')),
        {
          prehash: false,
          lowS: false
        }
      )
    } catch {
      /* malformed signatures are failed possession proofs */
    }
    if (!valid) throw new VaultError('wrong-key', 'Hardware failed the new vault output possession challenge')
  } finally {
    signer.release()
  }
}
