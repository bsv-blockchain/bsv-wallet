/**
 * Proof bar §4.3 — I2 exclusion matrix.
 *
 * I2: without ALL of {the mnemonic, one committed YubiKey, that key's correct
 * PIN}, no one can spend a Vault UTXO. This file drives every combination
 * that must FAIL CLOSED against one real v7 vault (N = 2 committed
 * MockYubiKey keys, real P-256 signing, no card) funded on a shared
 * in-memory FakeChain — reusing testSupport/fakeVaultChain.ts's
 * FakeChain/FakeVaultWallet and the same real-crypto approach
 * proofBar.cleanDeviceRecovery.test.ts uses (a real @bsv/sdk
 * CompletedProtoWallet wrapping core/mnemonicWallet.ts's primary key; never a
 * stub). Every negative has a positive control in the SAME test, proving the
 * harness is live and the rejection is specific to the missing factor.
 *
 * Cases (ledger PROOF-I2):
 *   (a) mnemonic only, no committed key
 *   (b) committed key + correct PIN, NO mnemonic, stolen v7 DB/backup material
 *   (c) wrong PIN
 *   (d) an unenrolled key (outsider)
 *   (e) DB + SecureStore (vault meta, drafts) without mnemonic and without any
 *       committed key
 *   (f) an external BRC-100 caller (non-admin originator) through
 *       guardVaultAccess
 * plus a v6-legacy residual, documented rather than hidden: a v6 output's
 * customInstructions DOES carry the salt, so stolen DB + a committed key +
 * its correct PIN CAN spend it (v7 closes exactly this hole; v7 is what every
 * deposit produces today — see transfers.ts's newVaultOutput).
 */
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
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
import { addVaultKey, adoptVaultKey } from '../../core/services/vault/VaultKeyService'
import { guardVaultAccess, VaultAccessDenied } from '../../core/services/vault/guard'
import {
  buildLock,
  buildUnlock,
  commitment,
  compressPubkey,
  decodeVaultInstructionsV7,
  sighashPreimage,
  signerDigest,
  verifyVaultInput,
  encodeVaultInstructions,
  type VaultInstructionsV6
} from '../../core/services/vault/r1comb'
import { vaultStore, type VaultKeyRecord, type VaultMeta } from '../../core/services/vault/vaultStore'
import { computeVaultMetaAuthorityTag, verifyVaultMetaAuthorityTag } from '../../core/services/vault/metaAuthority'
import { recoverVaultFromChain } from '../../core/services/vault/chainRecovery'
import {
  decryptVaultDescriptorPlaintext,
  deriveVaultSalt,
  depositToVault,
  getVaultBalance,
  parseVaultDescriptorScript,
  withdrawFromVault
} from '../../core/services/vault/transfers'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'

jest.setTimeout(300_000)

const ADMIN = 'admin.com'
const hex = (a: ArrayLike<number>): string => Utils.toHex(Array.from(a))
const digestBytes = (digestHex: string): Uint8Array => Uint8Array.from(Utils.toArray(digestHex, 'hex') as number[])
const p2pkhOut = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toAddress())

/** One MockYubiKey "keyring": every member gets its own persistent record —
 * see proofBar.cleanDeviceRecovery.test.ts's identical helper. */
async function buildKeyring(n: number): Promise<{ mock: MockYubiKey; keys: VaultKeyRecord[] }> {
  const mock = new MockYubiKey()
  const keys: VaultKeyRecord[] = []
  for (let i = 0; i < n; i++) {
    const serial = `YK-${2000 + i}`
    mock.insertKey(serial)
    const { publicKey } = await mock.generateVaultKey(serial)
    keys.push({ serial, slot: 0x82, pubkey: compressPubkey(publicKey), nickname: `Key ${i + 1}`, enrolledAt: i + 1 })
  }
  return { mock, keys }
}

/** Arm ceremonyHost's requestVaultSigner to present exactly `serial`'s
 * MockYubiKey record via the real card protocol, optionally with a WRONG pin
 * (case (c)). */
function armSigner(mock: MockYubiKey, serial: string, pin = '123456'): void {
  mock.insertKey(serial)
  setMockDriver(mock)
  ;(requestVaultSigner as jest.Mock).mockImplementation(async (_reason: string, chosenSerial: string) => {
    if (chosenSerial !== serial) throw new Error(`serial-mismatch: armed ${serial}, chose ${chosenSerial}`)
    const info = await mock.readVaultPublicKey(serial)
    const signer: VaultSigner = {
      serial,
      pubkey: compressPubkey(info!.publicKey),
      sign: async digestHex => {
        const { signature } = await mock.signEcdsa(serial, pin, digestHex)
        return Utils.toArray(signature, 'hex') as number[]
      },
      release: () => {}
    }
    return signer
  })
}

/** Seeds a device's own local meta the way finalizeEnrollment leaves it —
 * validly tagged with THAT device's own wallet-root HMAC. See
 * proofBar.cleanDeviceRecovery.test.ts's identical helper for why this
 * bypasses the real enrollment ceremony (a separately covered surface). */
async function seedOwnMeta(owner: FakeVaultWallet, meta: VaultMeta): Promise<void> {
  const scope = vaultStore.getScope()!
  await vaultStore.setMeta(meta, undefined, next => computeVaultMetaAuthorityTag(owner, ADMIN, next, scope))
}

interface VaultFixture {
  chain: FakeChain
  primaryKey: number[]
  deviceA: FakeVaultWallet
  mock: MockYubiKey
  keys: VaultKeyRecord[]
  identityKey: string
  txid: string
}

/** One real v7 vault (N keys), funded on a fresh FakeChain, with device A
 * (the rightful owner) holding a live local session. `tag` must be a unique
 * 2-hex-char suffix per call so concurrently-described scopes never collide
 * in the vaultStore singleton. */
async function setupVault(tag: string, n = 2, satoshis = 500_000): Promise<VaultFixture> {
  const identityKey = `02${tag}${'b3'.repeat(31)}`
  const chain = new FakeChain()
  const primaryKey = generateMnemonicWallet().primaryKey
  const deviceA = new FakeVaultWallet(primaryKey, chain)
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey, chain: 'test' })
  const { mock, keys } = await buildKeyring(n)
  await seedOwnMeta(deviceA, {
    v: 6, vaultId: hex(p256.utils.randomSecretKey()), revision: 1, createdAt: Date.now(), keys
  })
  armSigner(mock, keys[0].serial)
  const { txid } = await depositToVault(deviceA, ADMIN, satoshis)
  return { chain, primaryKey, deviceA, mock, keys, identityKey, txid }
}

/** The recovered/decoded v7 record for the sole vault output currently in
 * `w`'s 'admin vault' basket, plus its real outpoint, satoshis and on-chain
 * locking script. */
async function readVaultOutput(w: FakeVaultWallet) {
  const { outputs } = await w.listOutputs({
    basket: 'admin vault', include: 'locking scripts', includeCustomInstructions: true, limit: 10, offset: 0
  })
  expect(outputs).toHaveLength(1)
  const [row] = outputs
  const ci = decodeVaultInstructionsV7(row.customInstructions)
  if (!ci) throw new Error('vault output has no valid v7 record')
  return { outpoint: row.outpoint, satoshis: row.satoshis, lockingScript: LockingScript.fromHex(row.lockingScript!), ci }
}

/** A single-input spend transaction against `source`'s output `vout`, and the
 * R1C signer digest for it — matches proofBar.scriptMatrix.test.ts's approach
 * (pushTxDerCheck always reports `ok: true` for the two-key covenant branch,
 * so no retry loop is needed). */
function spendAgainst(source: Transaction, vout: number, sourceSats: number): { tx: Transaction; preimage: number[] } {
  const tx = new Transaction(1)
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
  tx.addOutput({ satoshis: sourceSats - 1000, lockingScript: p2pkhOut() })
  return { tx, preimage: sighashPreimage(tx, 0, sourceSats) }
}

function realDerSignature(priv: Uint8Array, preimage: number[]): number[] {
  return Array.from(p256.Signature.fromBytes(p256.sign(digestBytes(signerDigest(preimage)), priv, { prehash: false, lowS: false })).toBytes('der'))
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
  vaultStore.clearScope()
  ;(requestVaultSigner as jest.Mock).mockReset()
  setMockDriver(null)
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (a): mnemonic only, no committed key', () => {
  it('I2: chain recovery succeeds from the mnemonic alone, but withdrawal refuses before any physical key proves possession (positive control: adopting the committed key then succeeds)', async () => {
    const { chain, primaryKey, mock, keys, identityKey } = await setupVault('a1')

    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })

    const deviceB = new FakeVaultWallet(primaryKey, chain)
    const recovery = await recoverVaultFromChain(deviceB, ADMIN, fakeChainLookup(chain), 'test')
    expect(recovery.found).toBe(1)
    expect(recovery.problems).toEqual([])

    // Negative: mnemonic-only recovery never adopts a key — no physical key
    // has been presented — so withdrawal must refuse.
    await expect(
      withdrawFromVault(deviceB, ADMIN, 'all', 'no card presented', keys[0].serial)
    ).rejects.toMatchObject({ code: 'key-not-adopted' })

    // Positive control: the SAME device, the SAME recovered vault, spends
    // once the committed key actually proves possession.
    armSigner(mock, keys[0].serial)
    await adoptVaultKey({ record: keys[0], onPhase: () => {}, getPin: async () => '123456' })
    const spend = await withdrawFromVault(deviceB, ADMIN, 'all', 'with the committed key', keys[0].serial)
    expect(spend.txid).toBeTruthy()
  })

  it('I2: a signature from a key that was never committed, built with the CORRECT wallet-derived salt, is rejected by the strict interpreter (positive control: the real committed key, same salt, same lock, is accepted)', async () => {
    const { chain, primaryKey, mock, keys, identityKey } = await setupVault('a2')

    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })

    const deviceB = new FakeVaultWallet(primaryKey, chain)
    const recovery = await recoverVaultFromChain(deviceB, ADMIN, fakeChainLookup(chain), 'test')
    expect(recovery.found).toBe(1)

    const { outpoint, satoshis, lockingScript, ci } = await readVaultOutput(deviceB)
    // Correctly derived from the mnemonic alone — proving mnemonic knowledge
    // is not the missing factor here.
    const salt = await deriveVaultSalt(deviceB, ADMIN, ci.saltKeyId, ci.keys.map(k => k.serial))
    const rebuilt = buildLock({ commitments: ci.keys.map(k => commitment(k.pubkey, salt)), saltHex64: salt })
    expect(rebuilt.toHex()).toBe(lockingScript.toHex())

    const [txid, voutText] = outpoint.split('.')
    const sourceTx = chain.tx(txid)!
    const { tx, preimage } = spendAgainst(sourceTx, Number(voutText), satoshis)

    // Negative: an outsider keypair, never enrolled, signs the correct
    // preimage with the correct salt.
    const outsiderPriv = p256.utils.randomSecretKey()
    const outsiderPub = hex(p256.getPublicKey(outsiderPriv, true))
    const badUnlock = buildUnlock({ preimage, derSig: realDerSignature(outsiderPriv, preimage), pubkeyHex33: outsiderPub, saltHex64: salt })
    expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: satoshis, lockingScript, unlockingScript: badUnlock })).toThrow()

    // Positive control: the real committed key, same tx, same salt.
    mock.insertKey(keys[0].serial)
    const { signature } = await mock.signEcdsa(keys[0].serial, '123456', signerDigest(preimage))
    const goodUnlock = buildUnlock({ preimage, derSig: Utils.toArray(signature, 'hex') as number[], pubkeyHex33: keys[0].pubkey, saltHex64: salt })
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: satoshis, lockingScript, unlockingScript: goodUnlock })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (b): committed key + correct PIN, NO mnemonic, stolen v7 DB/backup material', () => {
  it('I2: the stolen v7 record carries no salt anywhere; a guessed-salt witness from the REAL committed key is rejected; the encrypted descriptor cannot be decrypted without the root (positive control: the real salt DOES verify and the real root DOES decrypt it)', async () => {
    const { chain, deviceA, mock, keys, txid } = await setupVault('b1')
    const sourceTx = chain.tx(txid)!

    // The stolen material: the exact customInstructions string an exported
    // DB / SQLite outputs row / backup chunk would carry for this output.
    const vaultOutIndex = sourceTx.outputs.findIndex(o => o.lockingScript.toBinary().length > 1000)
    expect(vaultOutIndex).toBeGreaterThanOrEqual(0)
    const raw = sourceTx.outputs[vaultOutIndex]

    // The descriptor/marker outputs sit adjacent to the vault output in the
    // SAME deposit transaction (transfers.ts's newVaultOutput ordering).
    let descriptorCiphertext: number[] | undefined
    for (const output of sourceTx.outputs) {
      const parsed = parseVaultDescriptorScript(output.lockingScript)
      if (parsed) { descriptorCiphertext = parsed.ciphertext; break }
    }
    if (!descriptorCiphertext) throw new Error('no v7 descriptor output found in the deposit transaction')

    // Read the customInstructions the wallet actually attached to the vault
    // output, straight from device A's own basket (the "stolen SQLite row").
    const row = (await deviceA.listOutputs({
      basket: 'admin vault', includeCustomInstructions: true, include: 'locking scripts', limit: 1, offset: 0
    })).outputs[0]
    const stolenCi = decodeVaultInstructionsV7(row.customInstructions)
    if (!stolenCi) throw new Error('stolen record did not decode as v7')
    expect(JSON.parse(row.customInstructions!)).not.toHaveProperty('salt')

    // Negative (a): the real committed key's real signature, but a GUESSED
    // salt (an attacker without the mnemonic has nothing else to try).
    const lockingScript = LockingScript.fromHex(row.lockingScript!)
    const { tx, preimage } = spendAgainst(sourceTx, vaultOutIndex, raw.satoshis!)
    mock.insertKey(keys[0].serial)
    const { signature } = await mock.signEcdsa(keys[0].serial, '123456', signerDigest(preimage))
    const guessedSalt = '00'.repeat(32)
    const guessedUnlock = buildUnlock({ preimage, derSig: Utils.toArray(signature, 'hex') as number[], pubkeyHex33: keys[0].pubkey, saltHex64: guessedSalt })
    expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: raw.satoshis!, lockingScript, unlockingScript: guessedUnlock })).toThrow()

    // Positive control (same signature, real salt derived by the REAL root).
    const realSalt = await deriveVaultSalt(deviceA, ADMIN, stolenCi.saltKeyId, stolenCi.keys.map(k => k.serial))
    const realUnlock = buildUnlock({ preimage, derSig: Utils.toArray(signature, 'hex') as number[], pubkeyHex33: keys[0].pubkey, saltHex64: realSalt })
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: raw.satoshis!, lockingScript, unlockingScript: realUnlock })).toBe(true)

    // Negative (b): the encrypted descriptor cannot be decrypted by a
    // different-root wallet either.
    const attacker = new FakeVaultWallet(generateMnemonicWallet().primaryKey, chain)
    await expect(
      decryptVaultDescriptorPlaintext(attacker, ADMIN, 'test', stolenCi.saltKeyId, descriptorCiphertext)
    ).rejects.toThrow()

    // Positive control: the real root decrypts it back to the exact record.
    const plaintext = await decryptVaultDescriptorPlaintext(deviceA, ADMIN, 'test', stolenCi.saltKeyId, descriptorCiphertext)
    expect(decodeVaultInstructionsV7(plaintext)).toEqual(stolenCi)
  })

  it('I2: getVaultBalance and withdrawFromVault both refuse for a different-root wallet holding the stolen basket rows, cached source transactions and vault meta — even WITH the real committed key and its correct PIN (positive control: the real-root wallet reads and spends normally)', async () => {
    const { chain, deviceA, mock, keys } = await setupVault('b2')

    // The "stolen DB": a raw copy of the SQLite basket rows plus their cached
    // source transactions, into a wallet built from a DIFFERENT root. Local
    // vaultStore meta (the "stolen SecureStore") is untouched — this is a
    // stolen-snapshot threat, not a fresh device.
    const attacker = new FakeVaultWallet(generateMnemonicWallet().primaryKey, chain)
    type Internals = { basket: Map<string, unknown>; sourceTxByTxid: Map<string, unknown> }
    ;(attacker as unknown as Internals).basket = new Map((deviceA as unknown as Internals).basket)
    ;(attacker as unknown as Internals).sourceTxByTxid = new Map((deviceA as unknown as Internals).sourceTxByTxid)

    // The attacker also has the physical committed key and its correct PIN —
    // the only factor deliberately granted to them in scenario (b).
    armSigner(mock, keys[0].serial)

    await expect(getVaultBalance(attacker, ADMIN)).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      withdrawFromVault(attacker, ADMIN, 'all', 'stolen DB + committed key + correct PIN, no mnemonic', keys[0].serial)
    ).rejects.toMatchObject({ code: 'template-invalid' })

    // Positive control: the real owner, same vault, same key.
    expect(await getVaultBalance(deviceA, ADMIN)).toBe(500_000)
    armSigner(mock, keys[0].serial)
    const spend = await withdrawFromVault(deviceA, ADMIN, 'all', 'legitimate withdrawal', keys[0].serial)
    expect(spend.txid).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (c): wrong PIN', () => {
  it('I2: a wrong PIN makes the ceremony fail closed — nothing is signed and the vault balance is unchanged (positive control: retrying with the correct PIN succeeds)', async () => {
    const { deviceA, mock, keys } = await setupVault('c1')

    armSigner(mock, keys[0].serial, '000000')
    await expect(
      withdrawFromVault(deviceA, ADMIN, 'all', 'wrong pin attempt', keys[0].serial)
    ).rejects.toThrow()

    // Nothing was signed: the card's own retry counter shows exactly one
    // failed attempt, and the vault balance is untouched.
    mock.insertKey(keys[0].serial)
    expect((await mock.getKeyInfo()).pinRetries).toBe(2)
    expect(await getVaultBalance(deviceA, ADMIN)).toBe(500_000)

    // Positive control: the correct PIN, same device, same key, succeeds.
    armSigner(mock, keys[0].serial, '123456')
    const spend = await withdrawFromVault(deviceA, ADMIN, 'all', 'correct pin', keys[0].serial)
    expect(spend.txid).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (d): an unenrolled key (outsider)', () => {
  it('I2: withdrawFromVault refuses an outsider serial before ever requesting a signer (positive control: a committed serial is accepted)', async () => {
    const { deviceA, mock, keys } = await setupVault('d1')

    await expect(
      withdrawFromVault(deviceA, ADMIN, 'all', 'outsider attempt', 'OUTSIDER-SERIAL-NEVER-ENROLLED')
    ).rejects.toMatchObject({ code: 'not-enrolled' })
    expect((requestVaultSigner as jest.Mock)).not.toHaveBeenCalled()

    armSigner(mock, keys[0].serial)
    const spend = await withdrawFromVault(deviceA, ADMIN, 'all', 'committed key', keys[0].serial)
    expect(spend.txid).toBeTruthy()
  })

  it("I2: even with the CORRECT salt, the strict interpreter rejects a real signature from a genuinely separate physical YubiKey that was never enrolled in this vault (positive control: a committed key's signature, same lock, same salt, is accepted)", async () => {
    const { chain, deviceA, mock, keys, txid } = await setupVault('d2')
    const sourceTx = chain.tx(txid)!
    const vaultOutIndex = sourceTx.outputs.findIndex(o => o.lockingScript.toBinary().length > 1000)
    const raw = sourceTx.outputs[vaultOutIndex]

    // An outsider's own, separate physical key — a real card, a real P-256
    // keypair generated on it, simply never part of this vault's key set.
    const outsider = new MockYubiKey()
    outsider.insertKey('OUTSIDER-CARD-1')
    const { publicKey: outsiderPub } = await outsider.generateVaultKey('OUTSIDER-CARD-1')

    // The correct salt for THIS deployed lock — the outsider does not
    // actually have any way to learn it without the mnemonic (see case (a)),
    // but even granting it to them, the outsider's own key still fails.
    const row = await deviceA.listOutputs({
      basket: 'admin vault', includeCustomInstructions: true, include: 'locking scripts', limit: 1, offset: 0
    })
    const ci = decodeVaultInstructionsV7(row.outputs[0].customInstructions)!
    const salt = await deriveVaultSalt(deviceA, ADMIN, ci.saltKeyId, keys.map(k => k.serial))
    const lockingScript = LockingScript.fromHex(row.outputs[0].lockingScript!)

    const { tx, preimage } = spendAgainst(sourceTx, vaultOutIndex, raw.satoshis!)
    const { signature } = await outsider.signEcdsa('OUTSIDER-CARD-1', '123456', signerDigest(preimage))
    const outsiderUnlock = buildUnlock({ preimage, derSig: Utils.toArray(signature, 'hex') as number[], pubkeyHex33: compressPubkey(outsiderPub), saltHex64: salt })
    expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: raw.satoshis!, lockingScript, unlockingScript: outsiderUnlock })).toThrow()

    // Positive control: a committed key, same tx, same salt, same lock.
    mock.insertKey(keys[0].serial)
    const good = await mock.signEcdsa(keys[0].serial, '123456', signerDigest(preimage))
    const goodUnlock = buildUnlock({ preimage, derSig: Utils.toArray(good.signature, 'hex') as number[], pubkeyHex33: keys[0].pubkey, saltHex64: salt })
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: raw.satoshis!, lockingScript, unlockingScript: goodUnlock })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (e): DB + SecureStore (vault meta, drafts) without mnemonic and without any committed key', () => {
  it('I2: nothing can produce a witness — getVaultBalance and withdrawFromVault both refuse (positive control: the real owner reads and spends normally)', async () => {
    const { chain, deviceA, keys } = await setupVault('e1')

    const attacker = new FakeVaultWallet(generateMnemonicWallet().primaryKey, chain)
    type Internals = { basket: Map<string, unknown>; sourceTxByTxid: Map<string, unknown> }
    ;(attacker as unknown as Internals).basket = new Map((deviceA as unknown as Internals).basket)
    ;(attacker as unknown as Internals).sourceTxByTxid = new Map((deviceA as unknown as Internals).sourceTxByTxid)
    // No committed key at all is ever armed for `attacker` in this case.

    await expect(getVaultBalance(attacker, ADMIN)).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      withdrawFromVault(attacker, ADMIN, 'all', 'no mnemonic, no key', keys[0].serial)
    ).rejects.toThrow()

    expect(await getVaultBalance(deviceA, ADMIN)).toBe(500_000)
  })

  it('I2: a forged meta authority tag does not verify for a different root, and addVaultKey refuses to append an attacker key onto the real (stolen) meta (positive control: the tag DOES verify for the real root)', async () => {
    const { chain, deviceA } = await setupVault('e2')

    const scope = vaultStore.getScope()!
    const scopeToken = vaultStore.captureScopeToken()
    const existing = (await vaultStore.getMeta())!
    const tag = await vaultStore.getMetaTag()

    const attacker = new FakeVaultWallet(generateMnemonicWallet().primaryKey, chain)

    // Positive control: the real root's tag verifies against the real
    // (stolen, but genuine) meta.
    expect(await verifyVaultMetaAuthorityTag(deviceA, ADMIN, existing, scope, tag)).toBe(true)
    // Negative: a different root cannot verify the SAME tag over the SAME
    // meta — it never ran the wallet's own code to produce it.
    expect(await verifyVaultMetaAuthorityTag(attacker, ADMIN, existing, scope, tag)).toBe(false)

    const forgedPriv = p256.utils.randomSecretKey()
    const forgedRecord: VaultKeyRecord = {
      serial: 'ATTACKER-FORGED-1',
      slot: 0x82,
      pubkey: hex(p256.getPublicKey(forgedPriv, true)),
      nickname: 'Forged',
      enrolledAt: Date.now()
    }
    await expect(
      addVaultKey(forgedRecord, scopeToken, { wallet: attacker, adminOriginator: ADMIN })
    ).rejects.toMatchObject({ code: 'template-invalid' })

    // The forged key never entered local meta.
    expect((await vaultStore.getMeta())?.keys.some(k => k.serial === 'ATTACKER-FORGED-1')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('I2 (f): an external BRC-100 caller through guardVaultAccess', () => {
  const TXID = 'ab'.repeat(32)
  let cachedVaultLock: string | undefined
  const vaultLockHex = () =>
    (cachedVaultLock ??= buildLock({ commitments: ['11'.repeat(20), '22'.repeat(20)], saltHex64: '33'.repeat(32) }).toHex())

  function action(over: Record<string, unknown> = {}) {
    return {
      txid: TXID,
      satoshis: 1,
      status: 'completed',
      isOutgoing: false,
      description: 'Normal action',
      version: 1,
      lockTime: 0,
      reference: 'normal-ref',
      labels: ['normal'],
      inputs: [],
      outputs: [],
      ...over
    }
  }

  function fakeWallet(storedActions: any[] = []) {
    const calls: { method: string; args: any; originator?: string }[] = []
    const rec = (method: string) => (args: any, originator?: string) => {
      calls.push({ method, args, originator })
      return Promise.resolve({ ok: true, method, accepted: true })
    }
    const listActions = async (args: any, originator?: string) => {
      calls.push({ method: 'listActions', args, originator })
      const labels: string[] = args?.labels ?? []
      const matching = labels.length === 0
        ? storedActions
        : storedActions.filter(item => labels.every((l: string) => item.labels?.includes(l)))
      const offset = args?.offset ?? 0
      const limit = args?.limit ?? 10
      return { totalActions: matching.length, actions: matching.slice(offset, offset + limit) }
    }
    return {
      calls,
      wallet: {
        getPublicKey: rec('getPublicKey'),
        decrypt: rec('decrypt'),
        createHmac: rec('createHmac'),
        createAction: rec('createAction'),
        signAction: rec('signAction'),
        internalizeAction: rec('internalizeAction'),
        listActions
      } as any
    }
  }

  it('I2: createAction/internalizeAction refuse a FRESH R1C-shaped output for a non-admin originator (positive control: an ordinary output is accepted)', async () => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)

    await expect(
      guarded.createAction(
        { description: 'hide a vault output', outputs: [{ satoshis: 1, lockingScript: vaultLockHex(), outputDescription: 'x', basket: 'normal' }] } as any,
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)

    const freshTx = new Transaction()
    freshTx.addOutput({ satoshis: 1000, lockingScript: LockingScript.fromHex(vaultLockHex()) })
    const freshBeef = new Beef()
    freshBeef.mergeTransaction(freshTx)
    const beefBytes = new Uint8Array(freshBeef.toBinaryAtomic(freshTx.id('hex')))
    await expect(
      guarded.internalizeAction(
        { tx: beefBytes, outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'general' } }], description: 'attempt' } as any,
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)

    const ok = await guarded.createAction(
      { description: 'ordinary', outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'x', basket: 'normal' }] } as any,
      'evil.com'
    )
    expect(ok).toBeTruthy()
    expect(calls.some(c => c.method === 'createAction' && c.originator === 'evil.com')).toBe(true)
  })

  it('I2: createAction refuses to NAME an existing Vault outpoint as an input, and signAction refuses a pending Vault reference (positive controls: an ordinary outpoint/reference is accepted)', async () => {
    const historyWithVault = [
      action({
        inputs: [{ sourceOutpoint: `${TXID}.0`, sourceSatoshis: 50_000, sourceLockingScript: vaultLockHex(), inputDescription: 'Vault input', sequenceNumber: 0xffffffff }]
      })
    ]
    const { wallet } = fakeWallet(historyWithVault)
    const guarded = guardVaultAccess(wallet, ADMIN)

    await expect(
      guarded.createAction(
        { description: 'attempt', inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'x', unlockingScriptLength: 100 }], outputs: [] } as any,
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    const okInput = await guarded.createAction(
      { description: 'ordinary', inputs: [{ outpoint: `${'cd'.repeat(32)}.1`, inputDescription: 'x', unlockingScriptLength: 100 }], outputs: [] } as any,
      'evil.com'
    )
    expect(okInput).toBeTruthy()

    const historyWithReference = [
      action({
        reference: 'vault-ref', labels: ['vault', 'vault-withdraw'],
        inputs: [{ sourceOutpoint: `${TXID}.0`, sourceSatoshis: 50_000, sourceLockingScript: vaultLockHex(), inputDescription: 'Vault input', sequenceNumber: 0xffffffff }]
      })
    ]
    const { wallet: wallet2 } = fakeWallet(historyWithReference)
    const guarded2 = guardVaultAccess(wallet2, ADMIN)
    await expect(
      guarded2.signAction({ reference: 'vault-ref', spends: {} } as any, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    const okSign = await guarded2.signAction({ reference: 'ordinary-ref', spends: {} } as any, 'evil.com')
    expect(okSign).toBeTruthy()
  })

  it('I2: createHmac/decrypt/getPublicKey under the reserved Vault protocol namespaces are denied for a non-admin originator (positive controls: the admin originator is allowed, and a non-reserved namespace is allowed for anyone)', async () => {
    const reserved: Array<['createHmac' | 'decrypt' | 'getPublicKey', string]> = [
      ['getPublicKey', 'vault salt'],
      ['createHmac', 'vault marker'],
      ['decrypt', 'vault descriptor'],
      ['createHmac', 'vault meta']
    ]
    for (const [method, protocolName] of reserved) {
      const { wallet, calls } = fakeWallet()
      const guarded = guardVaultAccess(wallet, ADMIN)
      await expect(
        (guarded[method] as any)({ protocolID: [2, protocolName], keyID: 'k', counterparty: 'self', ciphertext: [1], data: [1] }, 'evil.com')
      ).rejects.toBeInstanceOf(VaultAccessDenied)
      expect(calls.find(c => c.method === method)).toBeUndefined()

      // Positive control: the admin originator IS allowed through the same
      // reserved namespace.
      await (guarded[method] as any)({ protocolID: [2, protocolName], keyID: 'k', counterparty: 'self', ciphertext: [1], data: [1] }, ADMIN)
      expect(calls.find(c => c.method === method && c.originator === ADMIN)).toBeDefined()
    }

    // Positive control: a NON-reserved namespace is allowed for anyone.
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await guarded.getPublicKey({ protocolID: [1, 'ordinary'], keyID: 'k', counterparty: 'self' } as any, 'evil.com')
    expect(calls.find(c => c.method === 'getPublicKey')).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Note on scope: withdrawFromVault's own selection path (reduceVerifiedVault
// Outputs -> verifyVaultSaltDerivations) already cross-checks any LISTED v6
// salt claim against the ACTING wallet's own root-derived salt, and refuses
// on a mismatch. That is a real, useful defense in depth for THIS APP's own
// call path, and the first test below confirms it holds. It is not the
// underlying security boundary, though: a raw-transaction attacker who never
// calls into this app's withdrawFromVault at all is not subject to it. The
// R1C SCRIPT itself only ever checks the witness's salt against the BAKED
// commitments — and for a v6 output, the salt needed to satisfy those
// commitments is sitting in the open, inside customInstructions. The second
// test below proves that residual directly, at the script level, bypassing
// the app entirely — exactly what a real attacker with the stolen DB, the
// committed key and its correct PIN would do.
describe('I2 residual (v6 legacy): a stolen v6 output carries the salt', () => {
  it("I2 residual (v6 legacy): the app's own withdrawFromVault refuses a different-root wallet even for a v6 output (verifyVaultSaltDerivations cross-checks the listed salt claim against the acting wallet's own root) — but see the next test for why this is not the real security boundary", async () => {
    const identityKey = `02f6${'c4'.repeat(31)}`
    const chain = new FakeChain()
    const owner = generateMnemonicWallet()
    const deviceA = new FakeVaultWallet(owner.primaryKey, chain)
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })
    const { mock, keys } = await buildKeyring(2)
    await seedOwnMeta(deviceA, { v: 6, vaultId: hex(p256.utils.randomSecretKey()), revision: 1, createdAt: Date.now(), keys })

    // A LEGACY v6 output: the salt lives INSIDE customInstructions
    // (encodeVaultInstructions), unlike every v7 output this file's other
    // cases exercise. Genuinely derived from device A's own root (as the real
    // app would when creating it), so device A's own later reads succeed.
    const salt = await deriveVaultSalt(deviceA, ADMIN, '1', keys.map(k => k.serial))
    const lockingScript = buildLock({ commitments: keys.map(k => commitment(k.pubkey, salt)), saltHex64: salt })
    const v6: VaultInstructionsV6 = {
      v: 6, type: 'R1C', salt, saltKeyId: '1', chain: 'test',
      vaultId: hex(p256.utils.randomSecretKey()), revision: 1, createdAt: Date.now(), keys
    }
    const customInstructions = encodeVaultInstructions(v6)
    expect(JSON.parse(customInstructions)).toHaveProperty('salt', salt)

    const fundingTx = new Transaction()
    fundingTx.addOutput({ satoshis: 500_000, lockingScript })
    chain.publish(fundingTx, { confirmed: true })
    await deviceA.internalizeAction({
      tx: fundingTx.toAtomicBEEF(),
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'admin vault', customInstructions, tags: ['vault'] } }],
      description: 'legacy v6 deposit fixture'
    })
    expect(await getVaultBalance(deviceA, ADMIN)).toBe(500_000)

    const attacker = new FakeVaultWallet(generateMnemonicWallet().primaryKey, chain)
    type Internals = { basket: Map<string, unknown>; sourceTxByTxid: Map<string, unknown> }
    ;(attacker as unknown as Internals).basket = new Map((deviceA as unknown as Internals).basket)
    ;(attacker as unknown as Internals).sourceTxByTxid = new Map((deviceA as unknown as Internals).sourceTxByTxid)
    armSigner(mock, keys[0].serial)

    await expect(getVaultBalance(attacker, ADMIN)).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      withdrawFromVault(attacker, ADMIN, 'all', 'app-level attempt', keys[0].serial)
    ).rejects.toMatchObject({ code: 'template-invalid' })

    // Positive control: the real owner is unaffected.
    expect(await getVaultBalance(deviceA, ADMIN)).toBe(500_000)
  })

  it('I2 residual (v6 legacy): the R1C SCRIPT accepts a witness built straight from a v6 record\'s embedded salt — a raw-transaction attacker with the stolen DB, the committed key and its correct PIN needs no mnemonic and no app at all (positive control: the same witness shape is what the real owner would also produce)', async () => {
    const chain = new FakeChain()
    const { mock, keys } = await buildKeyring(2)

    const salt = hex(p256.utils.randomSecretKey())
    const lockingScript = buildLock({ commitments: keys.map(k => commitment(k.pubkey, salt)), saltHex64: salt })
    const v6: VaultInstructionsV6 = {
      v: 6, type: 'R1C', salt, saltKeyId: '1', chain: 'test',
      vaultId: hex(p256.utils.randomSecretKey()), revision: 1, createdAt: Date.now(), keys
    }
    // The exact string a stolen SQLite outputs row / exported DB / backup
    // chunk would carry for this output — the salt is right there.
    const stolenCustomInstructions = encodeVaultInstructions(v6)
    expect(JSON.parse(stolenCustomInstructions)).toMatchObject({ salt })

    const fundingTx = new Transaction()
    fundingTx.addOutput({ satoshis: 500_000, lockingScript })
    chain.publish(fundingTx, { confirmed: true })

    const { tx, preimage } = spendAgainst(fundingTx, 0, 500_000)
    // The attacker never derives anything — the salt was read straight out
    // of the stolen customInstructions string above.
    const leakedSalt = JSON.parse(stolenCustomInstructions).salt as string
    mock.insertKey(keys[0].serial)
    const { signature } = await mock.signEcdsa(keys[0].serial, '123456', signerDigest(preimage))
    const unlock = buildUnlock({
      preimage,
      derSig: Utils.toArray(signature, 'hex') as number[],
      pubkeyHex33: keys[0].pubkey,
      saltHex64: leakedSalt
    })
    expect(
      verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: 500_000, lockingScript, unlockingScript: unlock })
    ).toBe(true)
  })
})
