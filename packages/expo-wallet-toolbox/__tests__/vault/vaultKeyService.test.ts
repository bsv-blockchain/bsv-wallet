/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list. Driven
 * against the multi-serial mock YubiKey and the real (SecureStore-mocked)
 * vaultStore. The card is a SIGNER now: enrollment generates a fresh P-256
 * key on it and records the compressed public key, nothing else — so these
 * tests inspect the public record and the store. Generated public records are
 * durably staged in a non-authoritative SecureStore draft; only
 * finalizeEnrollment creates deposit authority.
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
import { PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { setMockDriver } from '../../core/services/vault/driver'
import { compressPubkey, vaultSaltFromPublicKey } from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  VAULT_MAX_KEYS,
  VAULT_MIN_KEYS,
  VAULT_SLOT,
  addVaultKey,
  adoptVaultKey,
  disableVault,
  enrollKey,
  finalizeEnrollment,
  metaFromVerifiedOutputs,
  resumeEnrollmentDraft,
  VaultEnrollmentPartialError
} from '../../core/services/vault/VaultKeyService'

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: '02' + 'ab'.repeat(32), chain: 'main' })
  mock = new MockYubiKey()
  mock.insertKey('MOCK-1')
  setMockDriver(mock)
})
afterEach(() => {
  setMockDriver(null)
  vaultStore.clearScope()
})

const PIN = '123456'

/** Enrollment args with the contract's required fields filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  pendingSerials: [] as string[],
  onPhase: () => {},
  getPin: async () => PIN,
  acknowledgeDedicatedPivApplication: true as const,
  requestPinChange: async () => ({ oldPin: PIN, newPin: '654321' }),
  requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '87654321' }),
  ...over
})

const rec = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: VAULT_SLOT,
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

async function finalizeReady(records: VaultKeyRecord[]): Promise<void> {
  const scopeToken = vaultStore.captureScopeToken()
  for (const record of records) {
    await vaultStore.preserveEnrollmentDraft({ record, assurance: 'ready' }, scopeToken)
  }
  await finalizeEnrollment(records, scopeToken)
}

async function stageReady(record: VaultKeyRecord): Promise<void> {
  await vaultStore.preserveEnrollmentDraft(
    { record, assurance: 'ready' },
    vaultStore.captureScopeToken()
  )
}

/** An NFC-shaped mock whose start() "connects the tap" at once. */
const nfcMock = (): MockYubiKey => {
  const nfc = new MockYubiKey()
  ;(nfc as unknown as { sessionBased: boolean }).sessionBased = true
  nfc.insertKey('MOCK-1')
  return nfc
}

describe('enrollKey', () => {
  test('one card session yields a key record and only a non-authoritative ready draft', async () => {
    const phases: string[] = []
    const before = Date.now()
    const record = await enrollKey(args({ onPhase: (p: string) => phases.push(p) }))

    // Persistent reader: no 'connecting' — there is no tap to wait for.
    expect(phases).toEqual(['pin-check', 'checking-slot', 'personalizing', 'generating', 'challenging', 'done'])
    expect(record.serial).toBe('MOCK-1')
    expect(record.slot).toBe(0x82)
    expect(record.nickname).toBe('Key 1')
    expect(record.enrolledAt).toBeGreaterThanOrEqual(before)
    expect(record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    // The compressed form of exactly the key now in the card's slot.
    const onCard = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    expect(record.pubkey).toBe(compressPubkey(onCard))

    // The recovery handle survives an app restart but cannot authorize a
    // deposit until finalizeEnrollment commits VaultMeta.
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([{ record, assurance: 'ready' }])
  })

  test('a ready draft remains valid when the wizard gives its public record a nickname', async () => {
    const first = await enrollKey(args())
    mock.insertKey('MOCK-2')
    const second = await enrollKey(args({ pendingSerials: [first.serial] }))
    await finalizeEnrollment([
      { ...first, nickname: 'Desk' },
      { ...second, nickname: 'Safe' }
    ])
    expect((await vaultStore.getMeta())!.keys.map(key => key.nickname)).toEqual(['Desk', 'Safe'])
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
  })

  test('a caller-supplied nickname is kept (trimmed); the default counts from the pending list', async () => {
    expect((await enrollKey(args({ nickname: '  Desk ' }))).nickname).toBe('Desk')
    mock.insertKey('MOCK-2')
    expect((await enrollKey(args({ pendingSerials: ['A', 'B'] }))).nickname).toBe('Key 3')
    mock.insertKey('MOCK-3')
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
    expect(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey)).toBe(a.pubkey)
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
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull() // slot untouched
  })

  test('a serial in the STORED key list is refused by the service itself (pendingSerials empty), BEFORE the PIN is spent or the slot is touched', async () => {
    // The wizard passes meta ∪ pending, but its copy of meta loads
    // asynchronously; the service reads the store itself, so an enrolled
    // card is refused however early the tap lands (spec §3.3 step 2).
    await vaultStore.setMeta(meta([{ ...rec(1), serial: 'MOCK-1' }, rec(2)]))
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const verifySpy = jest.spyOn(mock, 'verifyPin')
    const err = await enrollKey(args({ pendingSerials: [] })).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.message).toBe('MOCK-1') // same shape the wizard already resolves to a nickname
    expect(err.details).toEqual({ serial: 'MOCK-1' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(verifySpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull() // slot untouched
    // The stored list is exactly as it was: enrollKey reads meta, never writes it.
    expect((await vaultStore.getMeta())!.keys.map(k => k.serial)).toEqual(['MOCK-1', rec(2).serial])
  })

  test('a different card enrols normally while a vault is stored (the add-key path): meta is read, not written', async () => {
    await vaultStore.setMeta(meta([rec(1), rec(2)]))
    mock.insertKey('MOCK-2')
    const record = await enrollKey(args({ pendingSerials: [rec(1).serial, rec(2).serial] }))
    expect(record.serial).toBe('MOCK-2')
    expect(record.nickname).toBe('Key 3')
    expect((await vaultStore.getMeta())!.keys).toEqual([rec(1), rec(2)])
  })

  test('pin-locked propagates, and the slot is untouched', async () => {
    await mock.verifyPin('MOCK-1', '000000')
    await mock.verifyPin('MOCK-1', '000000')
    await mock.verifyPin('MOCK-1', '000000') // retries now 0
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'pin-locked' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull()
  })

  test('a wrong PIN → pin-invalid with retriesLeft; the slot is untouched', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args({ getPin: async () => '000000' }))).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2
    })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull()
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
    expect((await mock.verifyPin('MOCK-1', '654321')).ok).toBe(true)
  })

  test('requires factory PIN replacement and a distinct non-default PUK before contact', async () => {
    const start = jest.spyOn(mock, 'getKeyInfo')
    await expect(enrollKey(args({ requestPinChange: undefined }))).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      enrollKey(args({ requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '12345678' }) }))
    ).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      enrollKey(args({ requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '654321' }) }))
    ).rejects.toMatchObject({ code: 'template-invalid' })
    expect(start).not.toHaveBeenCalled()
  })

  test('requires a dedicated whole-PIV acknowledgement below the UI boundary', async () => {
    const getPin = jest.fn(async () => '123456')
    const info = jest.spyOn(mock, 'getKeyInfo')
    await expect(
      enrollKey(args({ acknowledgeDedicatedPivApplication: false, getPin }) as any)
    ).rejects.toMatchObject({ code: 'template-invalid' })
    expect(getPin).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  test('authenticates the default management key and rejects other occupied PIV slots before mutation', async () => {
    const changePin = jest.spyOn(mock, 'changePin')
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')
    mock.occupyOtherPivSlot()
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'slot-occupied' })
    expect(changePin).not.toHaveBeenCalled()
    expect(changePuk).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()

    mock = new MockYubiKey()
    mock.insertKey('MOCK-2')
    setMockDriver(mock)
    await mock.protectManagementKey('MOCK-2')
    const pin2 = jest.spyOn(mock, 'changePin')
    const puk2 = jest.spyOn(mock, 'changePuk')
    const generate2 = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'mgmt-key-custom' })
    expect(pin2).not.toHaveBeenCalled()
    expect(puk2).not.toHaveBeenCalled()
    expect(generate2).not.toHaveBeenCalled()
  })

  test('rejects an untrusted factory attestation before any PIV mutation', async () => {
    const changePin = jest.spyOn(mock, 'changePin')
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')
    mock.setManufacturerAttested(false)

    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'attestation-invalid' })
    expect(changePin).not.toHaveBeenCalled()
    expect(changePuk).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  test('requires the native preflight to return its structural attestation proof marker', async () => {
    const changePin = jest.spyOn(mock, 'changePin')
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')
    jest.spyOn(mock, 'preflightDedicatedPiv').mockResolvedValueOnce({
      ok: true,
      inspection: 'metadata'
    } as never)

    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'attestation-invalid' })
    expect(changePin).not.toHaveBeenCalled()
    expect(changePuk).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  test('binds each native command to the serial read for this enrollment', async () => {
    const realPreflight = mock.preflightDedicatedPiv.bind(mock)
    jest.spyOn(mock, 'preflightDedicatedPiv').mockImplementationOnce(async serial => {
      const result = await realPreflight(serial)
      // A second USB token becomes current between bridge calls. Every later
      // destructive command must compare the serial inside its own session.
      mock.insertKey('MOCK-2')
      return result
    })
    const changed = jest.spyOn(mock, 'changePin')

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'enrollment-partial',
      stage: 'pin-change-uncertain'
    })
    expect(changed).toHaveBeenCalledWith('MOCK-1', '123456', '654321')
    expect((await mock.getKeyInfo()).serial).toBe('MOCK-2')
    expect((await mock.getKeyInfo()).pinRetries).toBe(3)
    expect(await mock.readVaultPublicKey('MOCK-2')).toBeNull()
  })

  test('writes a PIN-change crash marker before issuing the PIN APDU', async () => {
    let rejectChange!: (error: unknown) => void
    let started!: () => void
    const called = new Promise<void>(resolve => {
      started = resolve
    })
    jest.spyOn(mock, 'changePin').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectChange = reject
          started()
        })
    )
    const enrollment = enrollKey(args())
    await called
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: 'MOCK-1', stage: 'pin-change-uncertain' })
    ])
    rejectChange(new Error('power lost during PIN APDU'))
    await expect(enrollment).rejects.toMatchObject({ stage: 'pin-change-uncertain', recoverySaved: true })
  })

  test('writes a PUK-change crash marker before issuing the PUK APDU', async () => {
    mock.setPin('999999')
    let rejectChange!: (error: unknown) => void
    let started!: () => void
    const called = new Promise<void>(resolve => {
      started = resolve
    })
    jest.spyOn(mock, 'changePuk').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectChange = reject
          started()
        })
    )
    const enrollment = enrollKey(args({ getPin: async () => '999999' }))
    await called
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: 'MOCK-1', stage: 'puk-change-uncertain' })
    ])
    rejectChange(new Error('power lost during PUK APDU'))
    await expect(enrollment).rejects.toMatchObject({ stage: 'puk-change-uncertain', recoverySaved: true })
  })

  test('writes a generation crash marker before issuing the key-generation APDU', async () => {
    let rejectGeneration!: (error: unknown) => void
    let started!: () => void
    const called = new Promise<void>(resolve => {
      started = resolve
    })
    jest.spyOn(mock, 'generateVaultKey').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectGeneration = reject
          started()
        })
    )
    const enrollment = enrollKey(args())
    await called
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: 'MOCK-1', stage: 'generation-uncertain' })
    ])
    rejectGeneration(new Error('power lost during key-generation APDU'))
    await expect(enrollment).rejects.toMatchObject({ stage: 'generation-uncertain', recoverySaved: true })
  })

  test('rejects malformed nickname and device serial before any token mutation', async () => {
    const info = jest.spyOn(mock, 'getKeyInfo')
    const pinChange = jest.spyOn(mock, 'changePin')
    const pukChange = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')

    await expect(enrollKey(args({ nickname: 'x'.repeat(65) }))).rejects.toMatchObject({ code: 'template-invalid' })
    expect(info).not.toHaveBeenCalled()

    info.mockResolvedValueOnce({ serial: '', firmwareVersion: '5.7.0', pinRetries: 3 })
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'template-invalid' })
    expect(pinChange).not.toHaveBeenCalled()
    expect(pukChange).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  test('accepts only 6–8 ASCII digits for every enrollment PIN and PUK before contact', async () => {
    const start = jest.spyOn(mock, 'getKeyInfo')
    await expect(enrollKey(args({ getPin: async () => '１２３４５６' }))).rejects.toMatchObject({
      code: 'template-invalid'
    })
    await expect(
      enrollKey(args({ requestPinChange: async () => ({ oldPin: '123456', newPin: 'ABCDEF' }) }))
    ).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(
      enrollKey(args({ requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '１２３４５６７８' }) }))
    ).rejects.toMatchObject({ code: 'template-invalid' })
    expect(start).not.toHaveBeenCalled()
  })

  test('a scope switch before personalization stops with zero token mutations and no write to the new wallet', async () => {
    let probeStarted!: () => void
    const started = new Promise<void>(resolve => {
      probeStarted = resolve
    })
    let rejectProbe!: (error: unknown) => void
    jest.spyOn(mock, 'signEcdsa').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectProbe = reject
          probeStarted()
        })
    )
    const changePin = jest.spyOn(mock, 'changePin')
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')

    const enrollment = enrollKey(args())
    await started
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
    rejectProbe(new VaultError('no-key', 'No key in slot'))

    await expect(enrollment).rejects.toMatchObject({ code: 'scope-changed' })
    expect(changePin).not.toHaveBeenCalled()
    expect(changePuk).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('a scope switch after key protection returns a recoverable public record and never writes wallet B', async () => {
    const scopeA = vaultStore.captureScopeToken()
    const realProtect = mock.protectManagementKey.bind(mock)
    jest.spyOn(mock, 'protectManagementKey').mockImplementationOnce(async serial => {
      const result = await realProtect(serial)
      vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
      return result
    })

    const err = await enrollKey(args()).catch(e => e)
    expect(err).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'key-protected' })
    expect(err.record).toMatchObject({ serial: 'MOCK-1', slot: VAULT_SLOT })
    expect(err.record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
    vaultStore.configureScope({ identityKey: '02' + 'ab'.repeat(32), chain: 'main' })
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([
      { record: err.record, assurance: 'challenge-required' }
    ])
    expect(scopeA.storageKey).toContain('vault_meta_v6_main_')
  })

  test('rotates the PUK and protects the management key before returning a record', async () => {
    const puk = jest.spyOn(mock, 'changePuk')
    const protect = jest.spyOn(mock, 'protectManagementKey')
    const record = await enrollKey(args())
    expect(record.serial).toBe('MOCK-1')
    expect(puk).toHaveBeenCalledWith('MOCK-1', '12345678', '87654321')
    expect(protect).toHaveBeenCalledTimes(1)
    await expect(mock.changePuk('MOCK-1', '12345678', '11223344')).rejects.toMatchObject({ code: 'puk-invalid' })
    await expect(mock.generateVaultKey('MOCK-1')).rejects.toMatchObject({ code: 'mgmt-key-custom' })
  })

  test('reports a generated key explicitly when management protection does not confirm', async () => {
    jest.spyOn(mock, 'protectManagementKey').mockRejectedValueOnce(new Error('transport lost'))
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'key-generated' })
    expect(err.record.serial).toBe('MOCK-1')
    expect(err.record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey)).toBe(err.record.pubkey)
    const [draft] = await vaultStore.getEnrollmentDrafts()
    expect(draft).toEqual({ record: err.record, assurance: 'management-uncertain' })
    const pin = jest.fn(async () => '654321')
    await expect(
      resumeEnrollmentDraft({ entry: draft, onPhase: () => {}, getPin: pin })
    ).rejects.toMatchObject({ code: 'enrollment-partial', stage: 'key-generated' })
    expect(pin).not.toHaveBeenCalled()
  })

  test('returns no enrollment record unless the protected key passes a fresh possession challenge', async () => {
    const realSign = mock.signEcdsa.bind(mock)
    jest.spyOn(mock, 'signEcdsa').mockImplementation(async (...signArgs) => {
      await realSign(...signArgs)
      return { signature: '3006020101020101' }
    })
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'key-protected' })
    expect(err.record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(await vaultStore.getMeta()).toBeNull()
    const [draft] = await vaultStore.getEnrollmentDrafts()
    expect(draft).toEqual({ record: err.record, assurance: 'challenge-required' })
    ;(mock.signEcdsa as jest.Mock).mockRestore()
    await expect(
      resumeEnrollmentDraft({ entry: draft, onPhase: () => {}, getPin: async () => '654321' })
    ).resolves.toEqual(err.record)
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([{ record: err.record, assurance: 'ready' }])
  })

  test('reports partial personalization without exposing credentials or persisting a record', async () => {
    const verify = jest.spyOn(mock, 'verifyPin')
    const realChangePuk = mock.changePuk.bind(mock)
    jest.spyOn(mock, 'changePuk').mockImplementationOnce(async (serial, oldPuk, newPuk) => {
      await realChangePuk(serial, oldPuk, newPuk)
      throw new Error('transport lost after PUK change')
    })
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'puk-change-uncertain' })
    expect(err.record).toBeUndefined()
    expect(JSON.stringify(err)).not.toContain('654321')
    expect(JSON.stringify(err)).not.toContain('87654321')
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: 'MOCK-1', stage: 'puk-change-uncertain' })
    ])
    const calls = verify.mock.calls.length
    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'enrollment-partial',
      stage: 'puk-change-uncertain',
      recoverySaved: true
    })
    expect(verify).toHaveBeenCalledTimes(calls)
    // This mock proves the APDU landed before transport failed. A caller cannot
    // know that, so it must quarantine the token instead of guessing old/new.
    await expect(mock.changePuk('MOCK-1', '87654321', '11223344')).resolves.toMatchObject({ ok: true })
  })

  test('a definitely wrong PUK is not called partial when no earlier mutation occurred', async () => {
    mock.setPin('999999')
    await expect(
      enrollKey(
        args({
          getPin: async () => '999999',
          requestPukChange: async () => ({ oldPuk: '11111111', newPuk: '87654321' })
        })
      )
    ).rejects.toMatchObject({ code: 'puk-invalid', retriesLeft: 2 })
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull()
  })

  test('a wrong PUK after factory-PIN rotation reports the confirmed PIN change', async () => {
    const err = await enrollKey(
      args({ requestPukChange: async () => ({ oldPuk: '11111111', newPuk: '87654321' }) })
    ).catch(e => e)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'pin-changed' })
    await expect(mock.verifyPin('MOCK-1', '654321')).resolves.toMatchObject({ ok: true })
    expect(await mock.readVaultPublicKey('MOCK-1')).toBeNull()
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

  test('refuses an occupied slot before changing the PUK or generating over it', async () => {
    mock.occupySlot() // e.g. an age-plugin-yubikey identity in slot 82
    const existing = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const pukSpy = jest.spyOn(mock, 'changePuk')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'slot-occupied' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(pukSpy).not.toHaveBeenCalled()
    expect(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey)).toBe(compressPubkey(existing))
  })

  test('malformed key material after generation is an explicit partial state and the occupied slot is not retried', async () => {
    const realGenerate = mock.generateVaultKey.bind(mock)
    const generate = jest.spyOn(mock, 'generateVaultKey').mockImplementationOnce(async slot => {
      await realGenerate(slot)
      return { publicKey: '04aabb', manufacturerAttestation: 'verified' }
    })
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toMatchObject({ code: 'enrollment-partial', stage: 'generation-uncertain' })
    expect(err.message).not.toContain('aabb')
    expect(await mock.readVaultPublicKey('MOCK-1')).not.toBeNull()
    await expect(
      enrollKey(
        args({
          getPin: async () => '654321',
          requestPukChange: async () => ({ oldPuk: '87654321', newPuk: '11223344' })
        })
      )
    ).rejects.toMatchObject({ code: 'enrollment-partial', stage: 'generation-uncertain' })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  test('a generated key response without the native attestation marker is quarantined', async () => {
    const realGenerate = mock.generateVaultKey.bind(mock)
    jest.spyOn(mock, 'generateVaultKey').mockImplementationOnce(async serial => {
      const { publicKey } = await realGenerate(serial)
      return { publicKey } as never
    })

    const err = await enrollKey(args()).catch(e => e)
    expect(err).toMatchObject({
      code: 'enrollment-partial',
      stage: 'generation-uncertain',
      recoverySaved: true
    })
    expect(err.cause).toMatchObject({ code: 'attestation-invalid' })
    expect(await mock.readVaultPublicKey('MOCK-1')).not.toBeNull()
  })

  test('NFC: the PIN is collected BEFORE the tap, every op runs in one session, and the alert text is forwarded', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    const order: string[] = []
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {
      order.push('session-start')
      // simulate the tap connecting
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({
        type: 'attached',
        serial: 'MOCK-1',
        transport: 'mock'
      })
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
    expect(phases).toEqual([
      'pin-check',
      'connecting',
      'checking-slot',
      'personalizing',
      'generating',
      'challenging',
      'done'
    ])
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
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({
        type: 'attached',
        serial: 'MOCK-1',
        transport: 'mock'
      })
    })
    // The card is pulled while the PIN verify is in flight; the verify never answers.
    jest.spyOn(nfc, 'verifyPin').mockImplementationOnce(() => {
      nfc.removeKey()
      return new Promise(() => {})
    })
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('adoptVaultKey', () => {
  test('proves possession of a restored record with a fresh signature without changing the slot', async () => {
    const enrolled = await enrollKey(args())
    await stageReady(rec(2))
    await finalizeEnrollment([enrolled, rec(2)])
    await vaultStore.clear()
    await vaultStore.restoreVerifiedMeta({
      v: 6,
      vaultId: '11'.repeat(32),
      revision: 1,
      createdAt: 1,
      keys: [enrolled, rec(2)]
    })
    const before = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    const generate = jest.spyOn(mock, 'generateVaultKey')
    const phases: string[] = []
    const adopted = await adoptVaultKey({
      record: enrolled,
      onPhase: p => phases.push(p),
      getPin: async () => '654321'
    })
    expect(adopted).toEqual(enrolled)
    expect(phases).toEqual(['pin-check', 'challenging', 'done'])
    expect(generate).not.toHaveBeenCalled()
    expect((await mock.readVaultPublicKey('MOCK-1'))!.publicKey).toBe(before)
    await expect(vaultStore.requireKeyAdopted(enrolled.serial)).resolves.toBeUndefined()
  })

  test('rejects a different serial or public key and never generates', async () => {
    const enrolled = await enrollKey(args())
    const generate = jest.spyOn(mock, 'generateVaultKey')
    await expect(
      adoptVaultKey({ record: { ...enrolled, serial: 'OTHER' }, onPhase: () => {}, getPin: async () => '654321' })
    ).rejects.toMatchObject({ code: 'serial-mismatch' })

    const wrong = { ...enrolled, pubkey: rec(9).pubkey }
    await expect(
      adoptVaultKey({ record: wrong, onPhase: () => {}, getPin: async () => '654321' })
    ).rejects.toMatchObject({
      code: 'wrong-key'
    })
    expect(generate).not.toHaveBeenCalled()
  })

  test('rejects a forged signature even when the driver reports the expected serial', async () => {
    const enrolled = await enrollKey(args())
    jest.spyOn(mock, 'signEcdsa').mockResolvedValueOnce({ signature: '3006020101020101' })
    await expect(
      adoptVaultKey({ record: enrolled, onPhase: () => {}, getPin: async () => '654321' })
    ).rejects.toMatchObject({ code: 'wrong-key' })
  })
})

describe('metaFromVerifiedOutputs', () => {
  const saltPublicKey = new PrivateKey(7).toPublicKey().toString()
  const salt = vaultSaltFromPublicKey(saltPublicKey, 'main')
  const instructions = (revision: number, keys: VaultKeyRecord[], over: Record<string, unknown> = {}) => ({
    v: 6 as const,
    type: 'R1C' as const,
    salt,
    saltPublicKey,
    saltKeyId: '1',
    chain: 'main' as const,
    vaultId: '11'.repeat(32),
    revision,
    createdAt: 1,
    keys,
    ...over
  })

  test('selects one consistent latest revision and detects an in-progress removal', () => {
    const oldKeys = [rec(1), rec(2), rec(3)]
    const active = [rec(1), rec(3)]
    const recovered = metaFromVerifiedOutputs([
      { instructions: instructions(1, oldKeys), txid: 'aa'.repeat(32) },
      { instructions: instructions(2, active), txid: 'bb'.repeat(32) },
      { instructions: { ...instructions(2, active), salt: 'bb'.repeat(32) }, txid: 'cc'.repeat(32) }
    ])
    expect(recovered.keys).toEqual(active)
    expect(recovered.revision).toBe(2)
    expect(recovered.pendingRemoval).toMatchObject({
      key: rec(2),
      keyIndex: 1,
      state: 'broadcast'
    })
    expect(JSON.stringify(recovered.pendingRemoval)).not.toContain('txids')
  })

  test('rejects mixed enrollments and conflicting key sets at one revision', () => {
    expect(() =>
      metaFromVerifiedOutputs([
        { instructions: instructions(1, [rec(1), rec(2)]), txid: 'aa'.repeat(32) },
        {
          instructions: instructions(1, [rec(1), rec(2)], { vaultId: '22'.repeat(32) }),
          txid: 'bb'.repeat(32)
        }
      ])
    ).toThrow('Conflicting vault enrollments')

    expect(() =>
      metaFromVerifiedOutputs([
        { instructions: instructions(2, [rec(1), rec(2)]), txid: 'aa'.repeat(32) },
        { instructions: instructions(2, [rec(1), rec(3)]), txid: 'bb'.repeat(32) }
      ])
    ).toThrow('Conflicting vault key sets')
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

  test('valid-looking public records cannot become deposit authority without ready challenge drafts', async () => {
    await expect(finalizeEnrollment([rec(1), rec(2)])).rejects.toMatchObject({ code: 'key-not-adopted' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('two records → scoped meta v6 with a fresh vault id; five is the ceiling', async () => {
    const before = Date.now()
    await finalizeReady([rec(1), rec(2)])
    expect(await vaultStore.isEnrolled()).toBe(true)
    const meta = (await vaultStore.getMeta())!
    expect(meta.v).toBe(6)
    expect(meta.vaultId).toMatch(/^[0-9a-f]{64}$/)
    expect(meta.revision).toBe(1)
    expect(meta.createdAt).toBeGreaterThanOrEqual(before)
    expect(meta.keys).toEqual([rec(1), rec(2)])
    expect(meta.lastUsedSerial).toBeUndefined()

    await disableVault() // a Finish never replaces a live vault (next test); start over first
    await finalizeReady([1, 2, 3, 4, 5].map(rec))
    expect((await vaultStore.getMeta())!.keys).toHaveLength(5)
  })

  test('a wizard scope token cannot finalize into a wallet selected later', async () => {
    const wizardScope = vaultStore.captureScopeToken()
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
    await expect(finalizeEnrollment([rec(1), rec(2)], wizardScope)).rejects.toMatchObject({ code: 'scope-changed' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('a vault already enrolled → key-already-enrolled naming an enrolled serial, the live key list untouched; with no vault it resolves', async () => {
    // Finish must never silently replace the key list that guards existing
    // deposits. The code is reused (no new locale copy); the serial lets the
    // wizard name a key it already knows.
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    await stageReady(rec(4))
    const err = await finalizeEnrollment([rec(3), rec(4)]).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: rec(1).serial })
    expect((await vaultStore.getMeta())!.keys).toEqual([rec(1), rec(2)])

    await disableVault()
    await expect(finalizeReady([rec(3), rec(4)])).resolves.toBeUndefined()
    expect((await vaultStore.getMeta())!.keys).toEqual([rec(3), rec(4)])
  })

  test('two REAL enrollments round-trip with lowercase compressed pubkeys', async () => {
    const a = await enrollKey(args({ nickname: 'Desk' }))
    mock.insertKey('MOCK-2')
    const b = await enrollKey(args({ pendingSerials: [a.serial], nickname: 'Safe' }))
    await finalizeEnrollment([a, b])
    const meta = (await vaultStore.getMeta())!
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
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
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    const meta = await addVaultKey(rec(3))
    expect(meta.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  test('addVaultKey requires the exact ready draft produced by enrollment', async () => {
    await finalizeReady([rec(1), rec(2)])
    await expect(addVaultKey(rec(3))).rejects.toMatchObject({ code: 'key-not-adopted' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  test('addVaultKey refuses a duplicate serial, a sixth key, and an unenrolled vault', async () => {
    await expect(addVaultKey(rec(1))).rejects.toMatchObject({ code: 'not-enrolled' })
    await finalizeReady([1, 2, 3, 4, 5].map(rec))
    await expect(addVaultKey(rec(6))).rejects.toMatchObject({ code: 'too-many-keys' })
    await disableVault()
    await finalizeReady([rec(1), rec(2)])
    await expect(addVaultKey({ ...rec(1), nickname: 'again' })).rejects.toMatchObject({ code: 'key-already-enrolled' })
  })

  test('an add-key wizard token cannot write into a wallet selected later', async () => {
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    const wizardScope = vaultStore.captureScopeToken()
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
    await expect(addVaultKey(rec(3), wizardScope)).rejects.toMatchObject({ code: 'scope-changed' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('disableVault clears the key list', async () => {
    await finalizeReady([rec(1), rec(2)])
    await disableVault()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })
})
