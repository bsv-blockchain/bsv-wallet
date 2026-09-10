/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list. Driven
 * against the multi-serial mock YubiKey and the real (AsyncStorage-mocked)
 * vaultStore. The card is a SIGNER now: enrollment generates a fresh P-256
 * key on it and records the compressed public key, nothing else — so these
 * tests inspect the public record and the store, and prove nothing reaches
 * disk until finalizeEnrollment.
 *
 * Plan 1's r1comb.ts must exist: compressPubkey is the canonical form.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
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
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { setMockDriver } from '../../core/services/vault/driver'
import { compressPubkey } from '../../core/services/vault/r1comb'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  VAULT_MAX_KEYS,
  VAULT_MIN_KEYS,
  VAULT_SLOT,
  addVaultKey,
  disableVault,
  enrollKey,
  finalizeEnrollment
} from '../../core/services/vault/VaultKeyService'

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  mock = new MockYubiKey()
  mock.insertKey('MOCK-1')
  setMockDriver(mock)
})
afterEach(() => setMockDriver(null))

const PIN = '123456'

/** Enrollment args with the contract's required fields filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  pendingSerials: [] as string[],
  onPhase: () => {},
  getPin: async () => PIN,
  ...over
})

const rec = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: VAULT_SLOT,
  pubkey: '02' + n.toString(16).padStart(2, '0').repeat(32),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

/** An NFC-shaped mock whose start() "connects the tap" at once. */
const nfcMock = (): MockYubiKey => {
  const nfc = new MockYubiKey()
  ;(nfc as unknown as { sessionBased: boolean }).sessionBased = true
  nfc.insertKey('MOCK-1')
  return nfc
}

describe('enrollKey', () => {
  test('one card session yields a key record with a compressed lowercase pubkey, and persists nothing', async () => {
    const phases: string[] = []
    const before = Date.now()
    const record = await enrollKey(args({ onPhase: (p: string) => phases.push(p) }))

    // Persistent reader: no 'connecting' — there is no tap to wait for.
    expect(phases).toEqual(['pin-check', 'generating', 'done'])
    expect(record.serial).toBe('MOCK-1')
    expect(record.slot).toBe(0x82)
    expect(record.nickname).toBe('Key 1')
    expect(record.enrolledAt).toBeGreaterThanOrEqual(before)
    expect(record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    // The compressed form of exactly the key now in the card's slot.
    const onCard = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    expect(record.pubkey).toBe(compressPubkey(onCard))

    // Nothing on disk yet — a user who backs out is simply not enrolled.
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('a caller-supplied nickname is kept (trimmed); the default counts from the pending list', async () => {
    expect((await enrollKey(args({ nickname: '  Desk ' }))).nickname).toBe('Desk')
    expect((await enrollKey(args({ pendingSerials: ['A', 'B'] }))).nickname).toBe('Key 3')
    expect((await enrollKey(args({ nickname: '   ' }))).nickname).toBe('Key 1')
  })

  test('two keys with different serials enrol through the same mock, each with its own pubkey', async () => {
    const a = await enrollKey(args())
    mock.insertKey('MOCK-2')
    const b = await enrollKey(args({ pendingSerials: [a.serial] }))
    expect(a.serial).toBe('MOCK-1')
    expect(b.serial).toBe('MOCK-2')
    expect(b.nickname).toBe('Key 2')
    expect(a.pubkey).not.toBe(b.pubkey)
    // A's slot key survived B's enrollment: records are per serial.
    mock.insertKey('MOCK-1')
    expect(compressPubkey((await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey)).toBe(a.pubkey)
  })

  test('a serial already enrolled or pending → key-already-enrolled, BEFORE the PIN is spent or the slot is touched', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const verifySpy = jest.spyOn(mock, 'verifyPin')
    const err = await enrollKey(args({ pendingSerials: ['MOCK-9', 'MOCK-1'] })).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.message).toBe('MOCK-1') // the wizard names the key from this
    expect(err.details).toEqual({ serial: 'MOCK-1' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(verifySpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull() // slot untouched
  })

  test('pin-locked propagates, and the slot is untouched', async () => {
    await mock.verifyPin('000000')
    await mock.verifyPin('000000')
    await mock.verifyPin('000000') // retries now 0
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'pin-locked' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull()
  })

  test('a wrong PIN → pin-invalid with retriesLeft; the slot is untouched', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args({ getPin: async () => '000000' }))).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2
    })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull()
  })

  test('a factory-PIN key (user enters 123456) forces a PIN change that reaches the card', async () => {
    let changeArgs: { oldPin: string; newPin: string } | null = null
    await enrollKey(
      args({
        getPin: async () => '123456', // factory
        requestPinChange: async () => {
          changeArgs = { oldPin: '123456', newPin: '654321' }
          return changeArgs
        }
      })
    )
    expect(changeArgs).toEqual({ oldPin: '123456', newPin: '654321' })
    expect((await mock.verifyPin('654321')).ok).toBe(true)
  })

  test('a non-factory PIN never triggers a change and never burns a retry', async () => {
    mock.setPin('999999') // key already has a custom PIN
    let changeCalled = false
    await enrollKey(
      args({
        getPin: async () => '999999',
        requestPinChange: async () => {
          changeCalled = true
          return { oldPin: '123456', newPin: 'x' }
        }
      })
    )
    expect(changeCalled).toBe(false)
    expect((await mock.getKeyInfo()).pinRetries).toBe(3)
  })

  test('always generates a fresh key, replacing whatever the slot held (spec D6) — no adoption', async () => {
    mock.occupySlot() // e.g. an age-plugin-yubikey identity in slot 82
    const existing = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const phases: string[] = []
    const record = await enrollKey(args({ onPhase: (p: string) => phases.push(p) }))
    expect(genSpy).toHaveBeenCalledTimes(1)
    expect(genSpy).toHaveBeenCalledWith(VAULT_SLOT)
    expect(record.pubkey).not.toBe(compressPubkey(existing))
    expect(phases).not.toContain('adopting')
  })

  test('malformed card key material → template-invalid, without echoing the bytes', async () => {
    jest.spyOn(mock, 'generateVaultKey').mockResolvedValueOnce({ publicKey: '04aabb' })
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toMatchObject({ code: 'template-invalid' })
    expect(err.message).not.toContain('aabb')
  })

  test('NFC: the PIN is collected BEFORE the tap, every op runs in one session, and the alert text is forwarded', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    const order: string[] = []
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {
      order.push('session-start')
      // simulate the tap connecting
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({ type: 'attached', serial: 'MOCK-1', transport: 'mock' })
    })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const phases: string[] = []

    const record = await enrollKey(
      args({
        onPhase: (p: string) => phases.push(p),
        getPin: async () => {
          order.push('pin-entered')
          return PIN
        },
        nfcMessage: 'Hold your YubiKey here to set it up'
      })
    )

    expect(record.serial).toBe('MOCK-1')
    expect(order).toEqual(['pin-entered', 'session-start'])
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledWith('Hold your YubiKey here to set it up')
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(phases).toEqual(['pin-check', 'connecting', 'generating', 'done'])
  })

  test('NFC: the system sheet being cancelled rejects the step with user-cancelled and closes the session', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    jest.spyOn(nfc, 'start').mockImplementation(() => nfc.failSession('user-cancelled'))
    const stopSpy = jest.spyOn(nfc, 'stop')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: the card leaving mid-session rejects the step with key-removed-mid-op', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    jest.spyOn(nfc, 'start').mockImplementation(() => {
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({ type: 'attached', serial: 'MOCK-1', transport: 'mock' })
    })
    // The card is pulled while the PIN verify is in flight; the verify never answers.
    jest.spyOn(nfc, 'verifyPin').mockImplementationOnce(() => {
      nfc.removeKey()
      return new Promise(() => {})
    })
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('finalizeEnrollment', () => {
  test('the bounds are 2 and 5', () => {
    expect(VAULT_MIN_KEYS).toBe(2)
    expect(VAULT_MAX_KEYS).toBe(5)
  })

  test('one record → not-enough-keys, nothing written', async () => {
    await expect(finalizeEnrollment([rec(1)])).rejects.toMatchObject({ code: 'not-enough-keys' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('six records → too-many-keys, nothing written', async () => {
    await expect(finalizeEnrollment([1, 2, 3, 4, 5, 6].map(rec))).rejects.toMatchObject({ code: 'too-many-keys' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('duplicate serials → key-already-enrolled (defensive: the wizard already refuses them)', async () => {
    const err = await finalizeEnrollment([rec(1), { ...rec(2), serial: rec(1).serial }]).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: rec(1).serial })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('two records → meta v5 persisted verbatim; five is the ceiling', async () => {
    const before = Date.now()
    await finalizeEnrollment([rec(1), rec(2)])
    expect(await vaultStore.isEnrolled()).toBe(true)
    const meta = (await vaultStore.getMeta())!
    expect(meta.v).toBe(5)
    expect(meta.createdAt).toBeGreaterThanOrEqual(before)
    expect(meta.keys).toEqual([rec(1), rec(2)])
    expect(meta.lastUsedSerial).toBeUndefined()

    await finalizeEnrollment([1, 2, 3, 4, 5].map(rec)) // a fresh Finish replaces the list
    expect((await vaultStore.getMeta())!.keys).toHaveLength(5)
  })

  test('two REAL enrollments round-trip with lowercase compressed pubkeys', async () => {
    const a = await enrollKey(args({ nickname: 'Desk' }))
    mock.insertKey('MOCK-2')
    const b = await enrollKey(args({ pendingSerials: [a.serial], nickname: 'Safe' }))
    await finalizeEnrollment([a, b])
    const meta = (await vaultStore.getMeta())!
    expect(meta.keys.map(k => k.serial)).toEqual(['MOCK-1', 'MOCK-2'])
    expect(meta.keys.map(k => k.nickname)).toEqual(['Desk', 'Safe'])
    for (const k of meta.keys) {
      expect(k.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
      expect(k.pubkey).toBe(k.pubkey.toLowerCase())
      expect(k.slot).toBe(0x82)
    }
  })
})

describe('addVaultKey / disableVault', () => {
  test('addVaultKey appends through vaultStore.addKey and returns the new meta', async () => {
    await finalizeEnrollment([rec(1), rec(2)])
    const meta = await addVaultKey(rec(3))
    expect(meta.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  test('addVaultKey refuses a duplicate serial, a sixth key, and an unenrolled vault', async () => {
    await expect(addVaultKey(rec(1))).rejects.toMatchObject({ code: 'not-enrolled' })
    await finalizeEnrollment([1, 2, 3, 4, 5].map(rec))
    await expect(addVaultKey(rec(6))).rejects.toMatchObject({ code: 'too-many-keys' })
    await finalizeEnrollment([rec(1), rec(2)])
    await expect(addVaultKey({ ...rec(1), nickname: 'again' })).rejects.toMatchObject({ code: 'key-already-enrolled' })
  })

  test('disableVault clears the key list', async () => {
    await finalizeEnrollment([rec(1), rec(2)])
    await disableVault()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })
})
