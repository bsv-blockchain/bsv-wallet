/**
 * Proof bar — clean-device recovery (I1). Ledger rows INT-01, INT-06,
 * XQ-012 exist for exactly this test, plus the backup-independence half of
 * XR-005/INT-02.
 *
 * I1: mnemonic AND any one enrolled YubiKey AND that key's valid PIN must
 * spend every Vault UTXO that committed that key, after phone loss /
 * reinstall / wiped DB.
 *
 * Device A: a wallet built from mnemonic M, with N enrolled MockYubiKey keys
 * (real P-256 signing, no card), makes real v7 deposits, one re-lock, and
 * one withdrawal-with-remainder — all landing on a shared in-memory
 * FakeChain (the "blockchain"). Device B: a BRAND-NEW FakeVaultWallet built
 * from the SAME mnemonic, with EMPTY local state (no vault meta, no basket
 * rows, no backup) — the AsyncStorage/SecureStore mocks are wiped between
 * device A and device B, exactly simulating phone loss / reinstall. Device B
 * presents exactly ONE committed key (each position in turn), runs
 * recoverVaultFromChain, then spends through the UNCHANGED withdraw path.
 * Every resulting vault input is checked by the real strict Spend
 * interpreter (verifyVaultInput) AND independently by noble p256 over the
 * signer digest — proving the mnemonic alone (plus one physically-present
 * key) reproduces the marker, the descriptor key, and the salt.
 *
 * Real key derivation throughout (core/mnemonicWallet.ts's m/0'/0' primary
 * key, wrapped in a real @bsv/sdk CompletedProtoWallet — the same
 * ProtoWallet/KeyDeriver machinery core/context/WalletContext.tsx uses) for
 * getPublicKey/createHmac/encrypt/decrypt — never stubs.
 */
import { P2PKH, PrivateKey, PublicKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v }),
      deleteItemAsync: jest.fn(async (k: string) => { delete store[k] }),
      __clear: () => { for (const k of Object.keys(store)) delete store[k] }
    }
  })()
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
jest.mock('../../core/toolboxConfig', () => ({
  getBackupUrl: jest.fn(() => 'https://backup.example'),
  isVaultEnabled: jest.fn(() => true),
  isVaultAvailable: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import type { VaultSigner } from '../../core/services/vault/ceremony'
import { generateMnemonicWallet } from '../../core/mnemonicWallet'
import { setMockDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { adoptVaultKey } from '../../core/services/vault/VaultKeyService'
import { compressPubkey, signerDigest, sighashPreimage, verifyVaultInput } from '../../core/services/vault/r1comb'
import { vaultStore, type VaultKeyRecord } from '../../core/services/vault/vaultStore'
import { recoverVaultFromChain } from '../../core/services/vault/chainRecovery'
import { depositToVault, relockVault, withdrawFromVault } from '../../core/services/vault/transfers'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'

jest.setTimeout(300_000)

const ADMIN = 'admin.com'
const hex = (a: ArrayLike<number>): string => Utils.toHex(Array.from(a))
const digestBytes = (digestHex: string): Uint8Array => Uint8Array.from(Utils.toArray(digestHex, 'hex') as number[])

/** One MockYubiKey "keyring": every member gets its own persistent record
 * (insertKey/generateVaultKey), and switching `insertKey` back to a serial
 * later re-presents the SAME key with a fresh (unverified) PIN session —
 * modelling "the same physical set of cards, present the one at position k". */
async function buildKeyring(n: number): Promise<{ mock: MockYubiKey; keys: VaultKeyRecord[] }> {
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
 * MockYubiKey record via the real card protocol (verifyPin + signEcdsa) —
 * real P-256 math, no card. Also installs `mock` as the active vault driver
 * (the seam adoptVaultKey/getVaultDriver() reads), so the possession
 * challenge after recovery goes through the same physical presentment. */
function armSigner(mock: MockYubiKey, serial: string): void {
  mock.insertKey(serial)
  setMockDriver(mock)
  ;(requestVaultSigner as jest.Mock).mockImplementation(async (_reason: string, chosenSerial: string) => {
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

/** Independently re-verify EVERY input of a completed spend: the real
 * strict interpreter (verifyVaultInput), AND noble p256 directly over the
 * signer digest against the committed pubkey — the same double-check
 * proofBar.scriptMatrix.test.ts uses for the R1C template itself. */
function independentlyVerifySpend(chain: FakeChain, txid: string, signerPubkeyHex: string): void {
  const tx = chain.tx(txid)
  if (!tx) throw new Error(`FakeChain has no record of ${txid}`)
  expect(tx.inputs.length).toBeGreaterThan(0)
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (!source) throw new Error(`input ${i} of ${txid} has no source`)
    // Only R1C (vault) inputs carry the 71-chunk comb witness; the fake never
    // spends anything else in these tests, but guard anyway.
    if (source.lockingScript.toBinary().length < 1000) continue
    const unlockingScript = input.unlockingScript!
    expect(
      verifyVaultInput({
        tx,
        inputIndex: i,
        sourceSatoshis: source.satoshis!,
        lockingScript: source.lockingScript,
        unlockingScript
      })
    ).toBe(true)

    const chunks = unlockingScript.chunks
    expect(chunks).toHaveLength(71)
    const r = scriptNumToBig(chunks[0].data!)
    const s = scriptNumToBig(chunks[67].data!)
    const preimage = chunks[69].data!
    const digest = signerDigest(preimage)
    const compact = new p256.Signature(r, s).toBytes('compact')
    expect(
      p256.verify(compact, digestBytes(digest), p256.Point.fromHex(signerPubkeyHex).toBytes(true), { prehash: false, lowS: true })
    ).toBe(true)
  }
}

function scriptNumToBig(b: number[]): bigint {
  if (b.length === 0) return 0n
  const le = [...b]
  const neg = (le[le.length - 1] & 0x80) !== 0
  le[le.length - 1] &= 0x7f
  let v = 0n
  for (let i = le.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(le[i])
  return neg ? -v : v
}

describe('proof bar: clean-device recovery (I1) — INT-01/INT-06/XQ-012', () => {
  beforeEach(async () => {
    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    ;(requestVaultSigner as jest.Mock).mockReset()
  })

  for (const n of [2, 3, 4, 5]) {
    describe(`N = ${n} enrolled keys`, () => {
      let mock: MockYubiKey
      let keys: VaultKeyRecord[]
      let primaryKey: number[]
      const identityKey = `02${n.toString(16).padStart(2, '0')}${'a1'.repeat(31)}`

      beforeAll(async () => {
        primaryKey = generateMnemonicWallet().primaryKey
        const keyring = await buildKeyring(n)
        mock = keyring.mock
        keys = keyring.keys
      })

      /** Fresh chain + fresh device-A deposit/re-lock/withdraw-with-remainder
       * sequence, so each position gets its own unspent, recoverable balance
       * rather than N-1 positions starving on a vault position 1 already
       * drained via a full 'all' withdrawal. */
      async function freshChainWithADeposits(): Promise<FakeChain> {
        const chain = new FakeChain()
        const deviceA = new FakeVaultWallet(primaryKey, chain)
        vaultStore.clearScope()
        vaultStore.configureScope({ identityKey, chain: 'test' })
        await vaultStore.setMeta({
          v: 6, vaultId: hex(p256.utils.randomSecretKey()), revision: 1, createdAt: Date.now(), keys
        })
        armSigner(mock, keys[0].serial)
        await depositToVault(deviceA, ADMIN, 500_000)
        await depositToVault(deviceA, ADMIN, 500_000)
        const relockResult = await relockVault(deviceA, ADMIN, 'Re-lock', keys[0].serial)
        independentlyVerifySpend(chain, relockResult.txid, keys[0].pubkey)
        // Withdraw part of the re-locked balance, re-vaulting the remainder —
        // exercises the marker/descriptor on the withdraw-remainder path too.
        const withdrawResult = await withdrawFromVault(deviceA, ADMIN, 300_000, 'Withdraw', keys[0].serial)
        independentlyVerifySpend(chain, withdrawResult.txid, keys[0].pubkey)
        expect((await vaultStore.getMeta())?.keys).toEqual(keys)
        return chain
      }

      for (let pos = 0; pos < n; pos++) {
        it(`device B recovers and spends with the committed key at position ${pos + 1} of ${n}`, async () => {
          const chain = await freshChainWithADeposits()

          // Phone loss / reinstall / wiped DB: no local vault meta, no
          // basket rows, no backup — only the mnemonic (primaryKey) and
          // whatever is actually on the shared chain survive.
          await AsyncStorage.clear()
          ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
          vaultStore.clearScope()
          vaultStore.configureScope({ identityKey, chain: 'test' })
          expect(await vaultStore.getMeta()).toBeNull()

          const deviceB = new FakeVaultWallet(primaryKey, chain)
          expect(deviceB.hasLocalVaultOutputs()).toBe(false)

          const recovery = await recoverVaultFromChain(deviceB, ADMIN, fakeChainLookup(chain), 'test')
          expect(recovery.found).toBeGreaterThan(0)
          expect(recovery.problems).toEqual([])

          const recoveredMeta = await vaultStore.getMeta()
          expect(recoveredMeta?.keys).toEqual(keys)

          // The YubiKey is needed only to RESTORE possession-adopt and to
          // SPEND — present exactly one, at this position — through the
          // unchanged withdraw path. restoreVerifiedMeta always sets
          // recovery.required with empty adoptedSerials, so the possession
          // challenge (adoptVaultKey) must run before this key can withdraw.
          armSigner(mock, keys[pos].serial)
          await adoptVaultKey({ record: keys[pos], onPhase: () => {}, getPin: async () => '123456' })

          // A partial amount (not 'all') leaves a remainder re-vaulted, so
          // the withdraw-remainder path is proven again on the recovered
          // device, and there is still something left for the re-lock check
          // below.
          const spend = await withdrawFromVault(deviceB, ADMIN, 200_000, `Recovered withdrawal (key ${pos + 1})`, keys[pos].serial)
          independentlyVerifySpend(chain, spend.txid, keys[pos].pubkey)

          // Recovered meta carries the full key list, so revocation
          // (re-lock) still works after recovery.
          const relockAfterRecovery = await relockVault(deviceB, ADMIN, 'Re-lock after recovery', keys[pos].serial)
          independentlyVerifySpend(chain, relockAfterRecovery.txid, keys[pos].pubkey)
        })
      }
    })
  }

  it('a different mnemonic finds nothing', async () => {
    const identityKey = `02${'b2'.repeat(32)}`
    const chain = new FakeChain()
    const owner = generateMnemonicWallet()
    const stranger = generateMnemonicWallet()
    const { mock, keys } = await buildKeyring(2)
    const vaultId = hex(p256.utils.randomSecretKey())

    const deviceA = new FakeVaultWallet(owner.primaryKey, chain)
    vaultStore.configureScope({ identityKey, chain: 'test' })
    await vaultStore.setMeta({ v: 6, vaultId, revision: 1, createdAt: Date.now(), keys })
    armSigner(mock, keys[0].serial)
    await depositToVault(deviceA, ADMIN, 500_000)

    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })

    const strangerWallet = new FakeVaultWallet(stranger.primaryKey, chain)
    const result = await recoverVaultFromChain(strangerWallet, ADMIN, fakeChainLookup(chain), 'test')
    expect(result.found).toBe(0)
    expect(result.pendingConfirmation).toBe(0)
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('an unconfirmed deposit is reported pending, not thrown and not counted as a miss', async () => {
    const identityKey = `02${'c3'.repeat(32)}`
    const chain = new FakeChain()
    const owner = generateMnemonicWallet()
    const { mock, keys } = await buildKeyring(2)
    const vaultId = hex(p256.utils.randomSecretKey())

    const deviceA = new FakeVaultWallet(owner.primaryKey, chain)
    vaultStore.configureScope({ identityKey, chain: 'test' })
    await vaultStore.setMeta({ v: 6, vaultId, revision: 1, createdAt: Date.now(), keys })
    armSigner(mock, keys[0].serial)
    const deposit = await depositToVault(deviceA, ADMIN, 500_000)
    // FakeVaultWallet.release() publishes confirmed by default; simulate the
    // deposit not having its first confirmation yet.
    ;(chain as any).setConfirmed(deposit.txid, false)

    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })

    const deviceB = new FakeVaultWallet(owner.primaryKey, chain)
    const result = await recoverVaultFromChain(deviceB, ADMIN, fakeChainLookup(chain), 'test')
    expect(result.found).toBe(0)
    expect(result.pendingConfirmation).toBe(1)
    expect(result.problems).toEqual([])
  })
})
