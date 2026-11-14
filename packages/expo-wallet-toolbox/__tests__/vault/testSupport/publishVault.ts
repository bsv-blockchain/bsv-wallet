/**
 * Shared builders for the Vault scan tests: a member key record and one
 * published v7 [vault, marker, descriptor] triple. No jest.mock here, so any
 * test file can import it.
 */
import { P2PKH, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  buildLock,
  commitment,
  encodeVaultInstructionsV7,
  type VaultInstructionKey,
  type VaultInstructionsV7
} from '../../../core/services/vault/r1comb'
import {
  buildVaultDescriptorScript,
  deriveVaultMarkerScript,
  deriveVaultSalt,
  encryptVaultDescriptorPlaintext
} from '../../../core/services/vault/transfers'
import type { FakeChain, FakeVaultWallet } from './fakeVaultChain'

export const ADMIN = 'admin.com'
export const CHAIN = 'test' as const
export const VAULT_ID = 'ab'.repeat(32)

export function newMember(nickname: string, enrolledAt: number): VaultInstructionKey {
  const priv = p256.utils.randomSecretKey()
  return {
    serial: `YK-${nickname}`,
    slot: 0x82,
    pubkey: Utils.toHex(Array.from(p256.getPublicKey(priv, true))),
    nickname,
    enrolledAt
  }
}

/** Build and publish (or withhold) one v7 [vault, marker, descriptor]
 * triple at index k, replicating newVaultOutput's construction directly
 * against the exported building blocks — this file's whole point is testing
 * chainRecovery.ts's SCAN logic, not re-testing output creation (transfers.test.ts
 * already does that). */
export async function publishVaultTx(
  wallet: FakeVaultWallet,
  chain: FakeChain,
  k: number,
  keys: VaultInstructionKey[],
  satoshis: number,
  opts: { confirmed?: boolean; vaultId?: string; createdAt?: number; revision?: number } = {}
): Promise<{ txid: string; vaultOutputIndex: number; customInstructions: string }> {
  const saltKeyId = String(k)
  const salt = await deriveVaultSalt(
    wallet,
    ADMIN,
    saltKeyId,
    keys.map(key => key.serial)
  )
  const lockingScript = buildLock({ commitments: keys.map(key => commitment(key.pubkey, salt)), saltHex64: salt })
  const v7: VaultInstructionsV7 = {
    v: 7,
    type: 'R1C',
    saltKeyId,
    chain: CHAIN,
    vaultId: opts.vaultId ?? VAULT_ID,
    revision: opts.revision ?? 1,
    createdAt: opts.createdAt ?? 1,
    keys
  }
  const customInstructions = encodeVaultInstructionsV7(v7)
  const markerScript = await deriveVaultMarkerScript(wallet, ADMIN, CHAIN, saltKeyId)
  const ciphertext = await encryptVaultDescriptorPlaintext(wallet, ADMIN, CHAIN, saltKeyId, customInstructions)
  const descriptorScript = buildVaultDescriptorScript(ciphertext)

  const fund = new Transaction()
  fund.addOutput({
    satoshis: satoshis + 10_000,
    lockingScript: new P2PKH().lock(Utils.toArray('e2'.repeat(20), 'hex'))
  })
  const tx = new Transaction(1)
  tx.addInput({
    sourceTransaction: fund,
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new UnlockingScript([])
  })
  tx.addOutput({ satoshis, lockingScript })
  tx.addOutput({ satoshis: 1, lockingScript: markerScript })
  tx.addOutput({ satoshis: 0, lockingScript: descriptorScript })
  tx.addOutput({ satoshis: 9_500, lockingScript: new P2PKH().lock(Utils.toArray('e3'.repeat(20), 'hex')) })

  const txid = chain.publish(tx, opts)
  return { txid, vaultOutputIndex: 0, customInstructions }
}
