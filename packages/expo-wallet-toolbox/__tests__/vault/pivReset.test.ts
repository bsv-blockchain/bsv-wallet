/**
 * pivReset — the guarded factory reset of a YubiKey's PIV application.
 *
 * A reset destroys the P-256 key in Vault slot 0x82. If that token is already
 * an enrolled vault key, the reset removes one of the k-of-n signers and can
 * make vault funds permanently unspendable, so every test here is about a
 * refusal that must happen BEFORE the card is touched — and once more inside
 * the card session, because the stored key list can change in between.
 *
 * "Before the card is touched" is asserted literally: the pre-contact refusals
 * check that neither `start()` (the iOS scan sheet) nor `getKeyInfo()` was ever
 * called. Asserting only that `resetPivApplication` was not reached passes even
 * if the pre-session guard is deleted, because the in-session guard catches the
 * same condition after the user has already been asked to tap.
 *
 * Driven against the multi-serial mock YubiKey and the real
 * (SecureStore-mocked) vaultStore, matching vaultKeyService.test.ts.
 */
// Own AsyncStorage mock, matching __tests__/vault/vaultKeyService.test.ts: the
// vault suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => {
        store[k] = v
      },
      removeItem: async (k: string) => {
        delete store[k]
      },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      deleteItemAsync: jest.fn(async (k: string) => {
        delete store[k]
      }),
      __clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  })()
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { setMockDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { resetPivApplication, type PivResetPhase } from '../../core/services/vault/pivReset'
import { vaultStore, VaultKeyRecord, VaultScopeChain } from '../../core/services/vault/vaultStore'

const SERIAL = 'MOCK-RST'
const OTHER = 'MOCK-OTHER'
const IDENTITY = '02' + 'ab'.repeat(32)
const OTHER_IDENTITY = '03' + 'cd'.repeat(32)

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: IDENTITY, chain: 'main' })
  mock = new MockYubiKey()
  mock.insertKey(SERIAL)
  setMockDriver(mock)
})

afterEach(() => {
  setMockDriver(null)
  vaultStore.clearScope()
  jest.restoreAllMocks()
})

const rec = (serial: string, n = 1): VaultKeyRecord => ({
  serial,
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.Point.BASE.multiply(BigInt(n)).toBytes(true))),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

const meta = (keys: VaultKeyRecord[]) => ({
  v: 6 as const,
  vaultId: '11'.repeat(32),
  revision: 1,
  createdAt: 1,
  keys
})

/** Every way the card can be reached, so "before touching the card" means what
 * it says: `start()` is the iOS scan sheet, `getKeyInfo()` the first APDU. */
const cardContact = () => ({
  start: jest.spyOn(mock, 'start'),
  info: jest.spyOn(mock, 'getKeyInfo'),
  reset: jest.spyOn(mock, 'resetPivApplication')
})

const expectUntouched = (spies: ReturnType<typeof cardContact>) => {
  expect(spies.start).not.toHaveBeenCalled()
  expect(spies.info).not.toHaveBeenCalled()
  expect(spies.reset).not.toHaveBeenCalled()
}

/** Enrol a key under one chain of the SAME wallet identity, then come back. */
const enrolOnChain = async (chain: VaultScopeChain, keys: VaultKeyRecord[]) => {
  const active = vaultStore.getScope()!
  vaultStore.configureScope({ identityKey: IDENTITY, chain })
  await vaultStore.setMeta(meta(keys))
  vaultStore.configureScope(active)
}

/** An NFC-shaped mock: start() "connects the tap" at once, so withKeySession
 * actually waits and the 'waiting' phase is reported. */
const nfcMock = (serial: string): MockYubiKey => {
  const nfc = new MockYubiKey()
  ;(nfc as unknown as { sessionBased: boolean }).sessionBased = true
  nfc.insertKey(serial)
  return nfc
}

test('resets a used key and clears its enrollment draft', async () => {
  mock.personalise('998877', '11112222')
  expect(mock.isFactory(SERIAL)).toBe(false)
  const scope = vaultStore.captureScopeToken()
  await vaultStore.preserveEnrollmentDraft({ record: rec(SERIAL), assurance: 'ready' }, scope)
  expect(await vaultStore.getEnrollmentDrafts()).toHaveLength(1)

  await resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })

  expect(mock.isFactory(SERIAL)).toBe(true)
  expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
})

test('clears the crash quarantine marker the reset just made meaningless', async () => {
  // A draft and a quarantine can never coexist for one serial (vaultStore
  // refuses it), so the quarantine path gets its own card.
  const scope = vaultStore.captureScopeToken()
  await vaultStore.preserveEnrollmentQuarantine(SERIAL, 'generation-uncertain', scope)
  expect(await vaultStore.getEnrollmentQuarantines()).toHaveLength(1)

  await resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })

  expect(mock.isFactory(SERIAL)).toBe(true)
  expect(await vaultStore.getEnrollmentQuarantines()).toEqual([])
})

test('refuses without the destruction acknowledgement, before touching the card', async () => {
  const spies = cardContact()
  await expect(
    // @ts-expect-error deliberately omitting the acknowledgement
    resetPivApplication({ serial: SERIAL })
  ).rejects.toMatchObject({ code: 'template-invalid' })
  expectUntouched(spies)
})

test('refuses a serial that is already an enrolled vault key, before touching the card', async () => {
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]))
  mock.personalise('998877', '11112222')
  const spies = cardContact()

  const err = await resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true }).catch(e => e)
  expect(err).toMatchObject({ code: 'key-already-enrolled' })
  expect(err.message).toBe(SERIAL) // the wizard names the key from this
  expect(err.details).toEqual({ serial: SERIAL })

  expectUntouched(spies)
  expect(mock.isFactory(SERIAL)).toBe(false) // the card was not touched
  // The refusal never edits the key list it is protecting.
  expect((await vaultStore.getMeta())!.keys.map(k => k.serial)).toEqual([SERIAL, 'MOCK-2'])
})

test('refuses a key that is mid-removal, before touching the card', async () => {
  // isVaultMeta GUARANTEES a pendingRemoval key is absent from meta.keys, so a
  // refusal set built from meta.keys alone lets it through. It is still
  // recoverable — cancelUnbroadcastKeyRemoval splices it back in — so wiping it
  // leaves the vault listing an active signer whose card holds no key.
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2), rec('MOCK-3', 3)]))
  const after = await vaultStore.beginKeyRemoval(SERIAL)
  expect(after.keys.map(k => k.serial)).not.toContain(SERIAL)
  expect(after.pendingRemoval!.key.serial).toBe(SERIAL)
  mock.personalise('998877', '11112222')
  const spies = cardContact()

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'key-already-enrolled',
    details: { serial: SERIAL }
  })

  expectUntouched(spies)
  expect(mock.isFactory(SERIAL)).toBe(false)
})

test('refuses a key enrolled under another chain of the same wallet, before touching the card', async () => {
  // The enrollment wizard is where the reset offer lives. Switch that wallet to
  // testnet and its key list is empty — but the YubiKey is one physical object
  // and is still a live mainnet signer.
  await enrolOnChain('main', [rec(SERIAL), rec('MOCK-2', 2)])
  vaultStore.configureScope({ identityKey: IDENTITY, chain: 'test' })
  expect(await vaultStore.getMeta()).toBeNull() // this chain sees nothing
  mock.personalise('998877', '11112222')
  const spies = cardContact()

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'key-already-enrolled',
    details: { serial: SERIAL }
  })

  expectUntouched(spies)
  expect(mock.isFactory(SERIAL)).toBe(false)
})

test('refuses a key mid-removal on another chain too', async () => {
  await enrolOnChain('teratest', [rec(SERIAL), rec('MOCK-2', 2), rec('MOCK-3', 3)])
  const active = vaultStore.getScope()!
  vaultStore.configureScope({ identityKey: IDENTITY, chain: 'teratest' })
  await vaultStore.beginKeyRemoval(SERIAL)
  vaultStore.configureScope(active)
  const spies = cardContact()

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'key-already-enrolled'
  })
  expectUntouched(spies)
})

test('a corrupt key list on any chain fails closed rather than reporting an empty one', async () => {
  await SecureStore.setItemAsync(`vault_meta_v6_test_${IDENTITY}`, 'not json at all')
  const spies = cardContact()

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'template-invalid'
  })
  expectUntouched(spies)
})

test('another wallet identity is not consulted — that residual is guard 3, not this one', async () => {
  // Documents the known limitation: SecureStore cannot be enumerated, so a
  // second identity's vault is invisible here. The card's own occupied slot is
  // what stops the wipe; see the slot-0x82 tests below.
  const active = vaultStore.getScope()!
  vaultStore.configureScope({ identityKey: OTHER_IDENTITY, chain: 'main' })
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]))
  vaultStore.configureScope(active)

  await expect(vaultStore.enrolledSerialsAcrossChains()).resolves.toEqual([])
})

test('refuses a serial listed in refuseSerials, before touching the card', async () => {
  mock.personalise('998877', '11112222')
  const spies = cardContact()

  await expect(
    resetPivApplication({
      serial: SERIAL,
      refuseSerials: [SERIAL],
      acknowledgeDestroysAllCredentials: true
    })
  ).rejects.toMatchObject({ code: 'key-already-enrolled', details: { serial: SERIAL } })

  expectUntouched(spies)
  expect(mock.isFactory(SERIAL)).toBe(false)
})

test('no caller flag can override the enrolled-serial refusal', async () => {
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]))
  const spies = cardContact()

  await expect(
    resetPivApplication({
      serial: SERIAL,
      acknowledgeDestroysAllCredentials: true,
      // Flags a future caller might reach for, including the one real consent
      // seam this service does have. None of them is a way past an enrolled
      // serial: that refusal is unconditional.
      acknowledgeUnrecognizedVaultKey: true,
      ...({ force: true, allowEnrolled: true, replaceOccupiedVaultSlot: true } as Record<string, unknown>)
    })
  ).rejects.toMatchObject({ code: 'key-already-enrolled' })
  expectUntouched(spies)
})

test('refuses a card whose Vault slot already holds an unrecognized key', async () => {
  // No vault on this device claims this serial, but slot 0x82 is not empty, so
  // the card is a signer for SOME vault — possibly another wallet identity's.
  mock.occupySlot()
  const held = (await mock.readVaultPublicKey(SERIAL))!.publicKey
  const reset = jest.spyOn(mock, 'resetPivApplication')

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'slot-occupied',
    details: { serial: SERIAL }
  })

  expect(reset).not.toHaveBeenCalled()
  expect((await mock.readVaultPublicKey(SERIAL))!.publicKey).toBe(held) // key intact
})

test('an explicit acknowledgement consents to wiping that unrecognized key', async () => {
  mock.occupySlot()
  await resetPivApplication({
    serial: SERIAL,
    acknowledgeDestroysAllCredentials: true,
    acknowledgeUnrecognizedVaultKey: true
  })
  expect(await mock.readVaultPublicKey(SERIAL)).toBeNull()
  expect(mock.isFactory(SERIAL)).toBe(true)
})

test('refuses when a different card is presented for the reset tap', async () => {
  mock.personalise('998877', '11112222')
  mock.removeKey()
  mock.insertKey(OTHER)
  const spy = jest.spyOn(mock, 'resetPivApplication')

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'serial-mismatch',
    details: { tapped: OTHER, chosen: SERIAL }
  })

  expect(spy).not.toHaveBeenCalled()
  expect(mock.isFactory(OTHER)).toBe(true) // the presented card was not reset either
  expect(mock.isFactory(SERIAL)).toBe(false) // and the chosen one is untouched
})

test('refuses a structurally invalid serial', async () => {
  const spies = cardContact()
  await expect(resetPivApplication({ serial: '', acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'template-invalid'
  })
  expectUntouched(spies)
})

test('re-reads the stored key list inside the session and refuses a key enrolled meanwhile', async () => {
  const scope = vaultStore.captureScopeToken()
  const enrolled = jest.spyOn(vaultStore, 'enrolledSerialsAcrossChains')
  const spy = jest.spyOn(mock, 'resetPivApplication')
  const realInfo = mock.getKeyInfo.bind(mock)
  // The vault is finalized between the pre-session guard and the tap — the
  // exact race the second read exists for.
  jest.spyOn(mock, 'getKeyInfo').mockImplementationOnce(async () => {
    await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]), scope)
    return realInfo()
  })

  await expect(resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'key-already-enrolled',
    details: { serial: SERIAL }
  })

  expect(spy).not.toHaveBeenCalled()
  expect(enrolled).toHaveBeenCalledTimes(2)
})

test('reports its phases in order and forwards the NFC alert text', async () => {
  const nfc = nfcMock(SERIAL)
  setMockDriver(nfc)
  nfc.personalise('998877', '11112222')
  const phases: PivResetPhase[] = []

  await resetPivApplication({
    serial: SERIAL,
    acknowledgeDestroysAllCredentials: true,
    nfcMessage: 'Hold your YubiKey here to reset it',
    onPhase: p => phases.push(p)
  })

  expect(phases).toEqual(['waiting', 'resetting'])
  expect(nfc.startMessage).toBe('Hold your YubiKey here to reset it')
  expect(nfc.isFactory(SERIAL)).toBe(true)
})

test('a persistent reader has no tap to wait for, so only the resetting phase is reported', async () => {
  const phases: PivResetPhase[] = []
  await resetPivApplication({
    serial: SERIAL,
    acknowledgeDestroysAllCredentials: true,
    onPhase: p => phases.push(p)
  })
  expect(phases).toEqual(['resetting'])
})
