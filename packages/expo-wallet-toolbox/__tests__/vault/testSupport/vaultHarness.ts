/**
 * Shared helpers for the Vault proof and hardening tests that deposit,
 * withdraw or re-lock against a FakeChain. A test file that imports this
 * module still declares its own jest.mock preamble (jest.mock is hoisted per
 * file): AsyncStorage, SecureStore, ceremonyHost, toolboxConfig and
 * backup/preference.
 */
import { Utils } from '@bsv/sdk'
import type { VaultSigner } from '../../../core/services/vault/ceremony'
import { setMockDriver } from '../../../core/services/vault/driver'
import { MockYubiKey } from '../../../core/services/vault/mockYubiKey'
import { computeVaultMetaAuthorityTag } from '../../../core/services/vault/metaAuthority'
import type { VaultChainLookup } from '../../../core/services/vault/markerLookup'
import { compressPubkey } from '../../../core/services/vault/r1comb'
import { vaultStore, type VaultKeyRecord, type VaultMeta } from '../../../core/services/vault/vaultStore'
import type { FakeVaultWallet } from './fakeVaultChain'

const { requestVaultSigner } = jest.requireMock('../../../core/services/vault/ceremonyHost') as {
  requestVaultSigner: jest.Mock
}

export const ADMIN = 'admin.com'

/** XR-002: seeds a device's very first local meta the way a real enrollment
 * (finalizeEnrollment) leaves it: validly tagged with THAT device's own
 * wallet-root HMAC, rather than the bare, untagged shape a SecureStore-only
 * attacker could equally produce. */
export async function seedOwnMeta(owner: FakeVaultWallet, meta: VaultMeta): Promise<void> {
  const scope = vaultStore.getScope()!
  await vaultStore.setMeta(meta, undefined, next => computeVaultMetaAuthorityTag(owner, ADMIN, next, scope))
}

/** One MockYubiKey "keyring": every member gets its own persistent record
 * (insertKey/generateVaultKey), and switching `insertKey` back to a serial
 * later re-presents the SAME key with a fresh (unverified) PIN session. */
export async function buildKeyring(n: number): Promise<{ mock: MockYubiKey; keys: VaultKeyRecord[] }> {
  const mock = new MockYubiKey()
  const keys: VaultKeyRecord[] = []
  for (let i = 0; i < n; i++) {
    const serial = `YK-${1000 + i}`
    mock.insertKey(serial)
    const { publicKey } = await mock.generateVaultKey(serial)
    keys.push({ serial, slot: 0x82, pubkey: compressPubkey(publicKey), nickname: `Key ${i + 1}`, enrolledAt: i + 1 })
  }
  return { mock, keys }
}

/** Arm ceremonyHost's requestVaultSigner to present exactly `serial`'s
 * MockYubiKey record via the real card protocol (verifyPin + signEcdsa):
 * real P-256 math, no card. Also installs `mock` as the active vault driver. */
export function armSigner(mock: MockYubiKey, serial: string): void {
  mock.insertKey(serial)
  setMockDriver(mock)
  requestVaultSigner.mockImplementation(async (_reason: string, chosenSerial: string) => {
    if (chosenSerial !== serial) throw new Error(`serial-mismatch: armed ${serial}, chose ${chosenSerial}`)
    const info = await mock.readVaultPublicKey(serial)
    const signer: VaultSigner = {
      serial,
      pubkey: compressPubkey(info!.publicKey),
      sign: async digestHex => {
        const { signature } = await mock.signEcdsa(serial, '123456', digestHex)
        return Utils.toArray(signature, 'hex') as number[]
      },
      release: () => {}
    }
    return signer
  })
}

/** A lookup over a chain with nothing on it: every marker has no history.
 * The other methods are never reached by salt allocation and throw. */
export function emptyChainLookup(): VaultChainLookup {
  const unused = async (): Promise<never> => {
    throw new Error('emptyChainLookup: only markerHistory is available')
  }
  return {
    markerHistory: async () => ({ status: 'none' }),
    transactionsForLockingScript: unused,
    transactionForTxid: unused,
    outputStatus: unused
  }
}
