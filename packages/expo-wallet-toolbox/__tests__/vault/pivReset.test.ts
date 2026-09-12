/**
 * pivReset — the guarded factory reset of a YubiKey's PIV application.
 *
 * A reset destroys the P-256 key in Vault slot 0x82. If that token is already
 * an enrolled vault key, the reset removes one of the k-of-n signers and can
 * make vault funds permanently unspendable, so every test here is about a
 * refusal that must happen BEFORE the card is touched — and once more inside
 * the card session, because the stored key list can change in between.
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
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'

const SERIAL = 'MOCK-RST'
const OTHER = 'MOCK-OTHER'

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: '02' + 'ab'.repeat(32), chain: 'main' })
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
  const spy = jest.spyOn(mock, 'resetPivApplication')
  await expect(
    // @ts-expect-error deliberately omitting the acknowledgement
    resetPivApplication({ serial: SERIAL })
  ).rejects.toMatchObject({ code: 'template-invalid' })
  expect(spy).not.toHaveBeenCalled()
})

test('refuses a serial that is already an enrolled vault key, before touching the card', async () => {
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]))
  mock.personalise('998877', '11112222')
  const spy = jest.spyOn(mock, 'resetPivApplication')

  const err = await resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true }).catch(e => e)
  expect(err).toMatchObject({ code: 'key-already-enrolled' })
  expect(err.message).toBe(SERIAL) // the wizard names the key from this
  expect(err.details).toEqual({ serial: SERIAL })

  expect(spy).not.toHaveBeenCalled()
  expect(mock.isFactory(SERIAL)).toBe(false) // the card was not touched
  // The refusal never edits the key list it is protecting.
  expect((await vaultStore.getMeta())!.keys.map(k => k.serial)).toEqual([SERIAL, 'MOCK-2'])
})

test('refuses a serial listed in refuseSerials, before touching the card', async () => {
  mock.personalise('998877', '11112222')
  const spy = jest.spyOn(mock, 'resetPivApplication')

  await expect(
    resetPivApplication({
      serial: SERIAL,
      refuseSerials: [SERIAL],
      acknowledgeDestroysAllCredentials: true
    })
  ).rejects.toMatchObject({ code: 'key-already-enrolled', details: { serial: SERIAL } })

  expect(spy).not.toHaveBeenCalled()
  expect(mock.isFactory(SERIAL)).toBe(false)
})

test('no caller flag can override the enrolled-serial refusal', async () => {
  await vaultStore.setMeta(meta([rec(SERIAL), rec('MOCK-2', 2)]))
  const spy = jest.spyOn(mock, 'resetPivApplication')

  await expect(
    resetPivApplication({
      serial: SERIAL,
      acknowledgeDestroysAllCredentials: true,
      // Flags a future caller might reach for. None of them is a consent seam:
      // a reset of an enrolled key is refused unconditionally.
      ...({ force: true, allowEnrolled: true, replaceOccupiedVaultSlot: true } as Record<string, unknown>)
    })
  ).rejects.toMatchObject({ code: 'key-already-enrolled' })
  expect(spy).not.toHaveBeenCalled()
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
  const spy = jest.spyOn(mock, 'resetPivApplication')
  await expect(resetPivApplication({ serial: '', acknowledgeDestroysAllCredentials: true })).rejects.toMatchObject({
    code: 'template-invalid'
  })
  expect(spy).not.toHaveBeenCalled()
})

test('re-reads the stored key list inside the session and refuses a key enrolled meanwhile', async () => {
  const scope = vaultStore.captureScopeToken()
  const getMeta = jest.spyOn(vaultStore, 'getMeta')
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
  expect(getMeta).toHaveBeenCalledTimes(2)
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
