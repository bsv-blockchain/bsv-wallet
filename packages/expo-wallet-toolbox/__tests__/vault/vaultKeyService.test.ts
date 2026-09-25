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
import { Hash, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { setMockDriver } from '../../core/services/vault/driver'
import {
  computeVaultDraftAuthorityTag,
  verifyVaultMetaAuthorityTag,
  type HmacCapableWallet
} from '../../core/services/vault/metaAuthority'
import { compressPubkey } from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  VAULT_MAX_KEYS,
  VAULT_MAX_ACTIVE_KEYS,
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

// XR-001 / XR-002: a deterministic, real-crypto stand-in for the admin-scoped
// wallet — matches transfers.test.ts's own `wallet.createHmac` fixture
// (SALT_DERIVER.deriveSymmetricKey + Hash.sha256hmac) so verifyHmac can
// genuinely round-trip a tag createHmac produced, not merely a stub that
// always answers `valid: true`.
const WALLET_ROOT = new KeyDeriver(new PrivateKey(919))
const ADMIN = 'admin.vaultkeyservice.test'
// @bsv/sdk's own VerifyHmacResult types `valid` as the literal `true`: a
// mismatched HMAC REJECTS rather than resolving `valid: false` (see
// connectionAuthority.ts's own comment on this) — matched exactly here so a
// forged tag exercises the real rejection path metaAuthority.ts's try/catch
// is written to handle, not a resolved-false shortcut.
const FAKE_WALLET: HmacCapableWallet = {
  createHmac: async (hmacArgs: any) => ({
    hmac: Array.from(
      Hash.sha256hmac(
        WALLET_ROOT.deriveSymmetricKey(hmacArgs.protocolID, hmacArgs.keyID, hmacArgs.counterparty).toArray(),
        hmacArgs.data
      )
    )
  }),
  verifyHmac: async (hmacArgs: any) => {
    const expected = Array.from(
      Hash.sha256hmac(
        WALLET_ROOT.deriveSymmetricKey(hmacArgs.protocolID, hmacArgs.keyID, hmacArgs.counterparty).toArray(),
        hmacArgs.data
      )
    )
    if (JSON.stringify(expected) !== JSON.stringify(hmacArgs.hmac)) throw new Error('HMAC mismatch')
    return { valid: true }
  }
}
const AUTHORITY = { wallet: FAKE_WALLET, adminOriginator: ADMIN }
/** A wallet whose createHmac/verifyHmac never agree with FAKE_WALLET's — a
 * stand-in for "not the real wallet", the same way a SecureStore-only
 * attacker's forged tag can never verify against the real one. */
const OTHER_WALLET: HmacCapableWallet = {
  createHmac: async () => ({ hmac: [1, 2, 3, 4] }),
  verifyHmac: async () => {
    throw new Error('HMAC mismatch')
  }
}

/** Enrollment args with the contract's required fields filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  pendingSerials: [] as string[],
  onPhase: () => {},
  getPin: async () => PIN,
  acknowledgeDedicatedPivApplication: true as const,
  requestPinChange: async () => ({ oldPin: PIN, newPin: '654321' }),
  requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '87654321' }),
  ...AUTHORITY,
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

/** Stages a `ready` draft the way legitimate code does — WITH the wallet-root
 * authority tag a live challenge would have produced (enrollKey's own
 * challenge is exercised directly by the 'enrollKey' describe block below;
 * this fixture stands in for "already proved possession" for tests whose
 * point is elsewhere). This is deliberately NOT `vaultStore.preserveEnrollmentDraft`
 * with no tagger at all — that shape is exactly XR-001's attack primitive,
 * exercised on its own by name below. */
async function stageReady(record: VaultKeyRecord): Promise<void> {
  const scopeToken = vaultStore.captureScopeToken()
  const scope = vaultStore.getScope()!
  await vaultStore.preserveEnrollmentDraft({ record, assurance: 'ready' }, scopeToken, r =>
    computeVaultDraftAuthorityTag(FAKE_WALLET, ADMIN, r, scope)
  )
}

async function finalizeReady(records: VaultKeyRecord[]): Promise<void> {
  const scopeToken = vaultStore.captureScopeToken()
  for (const record of records) {
    await stageReady(record)
  }
  await finalizeEnrollment(records, scopeToken, AUTHORITY)
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
    await finalizeEnrollment(
      [
        { ...first, nickname: 'Desk' },
        { ...second, nickname: 'Safe' }
      ],
      undefined,
      AUTHORITY
    )
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
    await expect(enrollKey(args({ acknowledgeDedicatedPivApplication: false, getPin }) as any)).rejects.toMatchObject({
      code: 'template-invalid'
    })
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

  test('a personalised key is refused before the PIN the wizard supplies can spend a retry', async () => {
    // The wizard sends the factory PIN on the user's behalf, so a key that has
    // already been used for something else must be identified by the read-only
    // preflight — never by burning one of three retries on a code the user
    // never chose. personalise() protects the management key, which is exactly
    // what the real preflight refuses.
    const verify = jest.spyOn(mock, 'verifyPin')
    mock.personalise('999999', '99999999')

    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'mgmt-key-custom' })

    expect(verify).not.toHaveBeenCalled()
    expect((await mock.getKeyInfo()).pinRetries).toBe(3)
  })

  test.each(['pin-invalid', 'puk-invalid', 'mgmt-key-custom', 'attestation-invalid'] as const)(
    '%s from the card session carries the serial so a later reset can bind to that key',
    async code => {
      let over: Record<string, unknown> = {}
      if (code === 'mgmt-key-custom') {
        mock.personalise('999999', '99999999')
      } else if (code === 'attestation-invalid') {
        mock.setManufacturerAttested(false)
      } else if (code === 'pin-invalid') {
        mock.setPin('998877') // enrollKey is handed the factory PIN by its caller
      } else {
        // A wrong PUK is only a bare puk-invalid while no earlier mutation has
        // landed, so this card must already carry a non-factory PIN.
        mock.setPin('999999')
        over = {
          getPin: async () => '999999',
          requestPukChange: async () => ({ oldPuk: '11111111', newPuk: '87654321' })
        }
      }

      await expect(enrollKey(args(over))).rejects.toMatchObject({
        code,
        details: { serial: 'MOCK-1' }
      })
    }
  )

  test('tagging the serial never rebuilds a partial-enrollment error or a foreign throwable', async () => {
    // A rebuilt VaultError would silently drop stage/record/recoverySaved and
    // break the quarantine and draft-recovery machinery that reads them.
    const partial = new VaultEnrollmentPartialError('pin-changed', new Error('transport lost'), undefined, true)
    jest.spyOn(mock, 'verifyPin').mockRejectedValueOnce(partial)
    const tagged = await enrollKey(args()).catch(e => e)
    expect(tagged).toBe(partial)
    expect(tagged).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(tagged).toMatchObject({ code: 'enrollment-partial', stage: 'pin-changed', recoverySaved: true })
    // The serial is added to the SAME object rather than a rebuilt one, which
    // is the only way a partial can name its card without losing those fields.
    expect(tagged.details).toMatchObject({ serial: 'MOCK-1' })

    const foreign = new Error('bridge exploded')
    jest.spyOn(mock, 'preflightDedicatedPiv').mockRejectedValueOnce(foreign)
    await expect(enrollKey(args())).rejects.toBe(foreign)
  })

  test('a quarantined token names itself, so the only remedy it has can be offered', async () => {
    // Every later tap of a quarantined card short-circuits here, before the PIV
    // application is touched, and a PIV reset is the only thing that clears a
    // quarantine. The partial thrown carries no record, so without the tag the
    // wizard has no serial to bind a reset to — the card is left permanently
    // unenrollable AND unresettable in-app, under copy telling the user to
    // reset it.
    await vaultStore.preserveEnrollmentQuarantine('MOCK-1', 'pin-change-uncertain', vaultStore.captureScopeToken())
    const blocked = await enrollKey(args()).catch(e => e)
    expect(blocked).toBeInstanceOf(VaultEnrollmentPartialError)
    expect(blocked).toMatchObject({
      code: 'enrollment-partial',
      stage: 'pin-change-uncertain',
      recoverySaved: true,
      details: { serial: 'MOCK-1' }
    })
  })

  test('a serial already named on the error is kept, not overwritten by the tapped one', async () => {
    jest
      .spyOn(mock, 'verifyPin')
      .mockRejectedValueOnce(new VaultError('pin-invalid', 'Wrong PIN', 2, { serial: 'MOCK-OTHER' }))
    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2,
      details: { serial: 'MOCK-OTHER' }
    })
  })

  test('binds each native command to the serial read for this enrollment', async () => {
    // The swap rides on the slot-occupancy read, the LAST read-only card call
    // before personalization: preflight and verifyPin run ahead of it and would
    // catch the new serial themselves, leaving changePin unreached. (It used to
    // ride on a signEcdsa probe; that probe was replaced by GET METADATA when
    // firmware 5.7.4+ stopped answering 0x6A88 for an empty slot.)
    const realOccupancy = mock.isVaultSlotOccupied.bind(mock)
    jest.spyOn(mock, 'isVaultSlotOccupied').mockImplementationOnce(async (...occArgs) => {
      try {
        return await realOccupancy(...occArgs)
      } finally {
        // A second USB token becomes current between bridge calls. Every later
        // destructive command must compare the serial inside its own session.
        mock.insertKey('MOCK-2')
      }
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
    await expect(enrollment).rejects.toMatchObject({
      stage: 'pin-change-uncertain',
      recoverySaved: true,
      // Named, or the wizard can offer no reset for the quarantine just written.
      details: { serial: 'MOCK-1' }
    })
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
    await expect(enrollment).rejects.toMatchObject({
      stage: 'puk-change-uncertain',
      recoverySaved: true,
      // Named, or the wizard can offer no reset for the quarantine just written.
      details: { serial: 'MOCK-1' }
    })
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
    await expect(enrollment).rejects.toMatchObject({
      stage: 'generation-uncertain',
      recoverySaved: true,
      // Named, or the wizard can offer no reset for the quarantine just written.
      details: { serial: 'MOCK-1' }
    })
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
    // The occupancy read is parked open, then answered EMPTY once the scope has
    // moved: the point is that a clean "go ahead" still aborts, not that the
    // read itself failed. (It answers, rather than rejecting, because emptiness
    // is now a resolved value — the old signing probe signalled it by throwing.)
    let resolveProbe!: (value: { occupied: boolean }) => void
    jest.spyOn(mock, 'isVaultSlotOccupied').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveProbe = resolve
          probeStarted()
        })
    )
    const changePin = jest.spyOn(mock, 'changePin')
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')

    const enrollment = enrollKey(args())
    await started
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
    resolveProbe({ occupied: false })

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
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([{ record: err.record, assurance: 'challenge-required' }])
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
      resumeEnrollmentDraft({ ...AUTHORITY, entry: draft, onPhase: () => {}, getPin: pin })
    ).rejects.toMatchObject({
      code: 'enrollment-partial',
      stage: 'key-generated'
    })
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
      resumeEnrollmentDraft({ ...AUTHORITY, entry: draft, onPhase: () => {}, getPin: async () => '654321' })
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

  test('replaces only the occupied Vault slot after explicit consent', async () => {
    mock.occupySlot()
    const existing = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    const record = await enrollKey(args({ replaceOccupiedVaultSlot: true }))
    expect(record.pubkey).not.toBe(compressPubkey(existing))
    expect(record.pubkey).toBe(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey))
  })

  test('XR-008: an explicit slot replacement never erases a signer enrolled under another chain of the same wallet', async () => {
    const identity = '02' + 'ab'.repeat(32)
    // Enrolled as a live signer on mainnet...
    vaultStore.configureScope({ identityKey: identity, chain: 'main' })
    await vaultStore.setMeta(meta([{ ...rec(1), serial: 'MOCK-1' }, rec(2)]))
    // ...then the SAME physical card is tapped while the wizard is open on
    // testnet, whose own key list is empty (a YubiKey is one physical
    // object; enrollKey must not judge occupancy from one chain's view).
    vaultStore.configureScope({ identityKey: identity, chain: 'test' })
    expect(await vaultStore.getMeta()).toBeNull()
    mock.occupySlot()
    const existing = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const err = await enrollKey(args({ replaceOccupiedVaultSlot: true })).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled', details: { serial: 'MOCK-1' } })
    expect(genSpy).not.toHaveBeenCalled()
    expect(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey)).toBe(compressPubkey(existing))
  })

  test('XR-008: an explicit slot replacement never erases a signer that is mid-removal in the current chain', async () => {
    await vaultStore.setMeta(meta([{ ...rec(1), serial: 'MOCK-1' }, rec(2), rec(3)]))
    // isVaultMeta guarantees a pendingRemoval key is absent from meta.keys, so
    // a refusal set built from meta.keys alone lets it straight through — it
    // is still recoverable (cancelUnbroadcastKeyRemoval splices it back in).
    await vaultStore.beginKeyRemoval('MOCK-1')
    mock.occupySlot()
    const existing = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const err = await enrollKey(args({ replaceOccupiedVaultSlot: true })).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled', details: { serial: 'MOCK-1' } })
    expect(genSpy).not.toHaveBeenCalled()
    expect(compressPubkey((await mock.readVaultPublicKey('MOCK-1'))!.publicKey)).toBe(compressPubkey(existing))
  })

  test('explicit Vault-slot replacement does not permit another occupied PIV slot', async () => {
    mock.occupyOtherPivSlot()
    await expect(enrollKey(args({ replaceOccupiedVaultSlot: true }))).rejects.toMatchObject({
      code: 'slot-occupied'
    })
  })

  // The three tests below pin the slot PROBE, not the preflight. Preflight now
  // runs first and refuses an occupied card before the probe is reached, so
  // without these the probe's refusals are unreachable from any test and could
  // be deleted unnoticed. The probe is the iOS-safe second line: it catches a
  // slot key that native cannot attest or even read back — an imported key, an
  // overwritten attestation slot, an ambiguous transport — which is exactly the
  // case where preflight says "I cannot prove this slot is occupied".
  const preflightPasses = (key: MockYubiKey = mock) =>
    jest.spyOn(key, 'preflightDedicatedPiv').mockResolvedValue({
      ok: true,
      inspection: 'metadata',
      manufacturerAttestation: 'verified'
    })

  test('the slot probe refuses a readable slot key that preflight waved through', async () => {
    mock.occupySlot()
    const existing = (await mock.readVaultPublicKey('MOCK-1'))!.publicKey
    preflightPasses()
    const changePuk = jest.spyOn(mock, 'changePuk')
    const generate = jest.spyOn(mock, 'generateVaultKey')

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'slot-occupied',
      details: { serial: 'MOCK-1' }
    })

    expect(changePuk).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect((await mock.readVaultPublicKey('MOCK-1'))!.publicKey).toBe(existing)
  })

  test('the slot probe refuses a slot whose certificate reads back even when nothing signs', async () => {
    // A PIV slot can hold a certificate whose private key is gone or never
    // matched: the public key reads back, but a signature attempt answers
    // no-key — which the probe alone would read as "empty, generate away".
    // That readable key is what recovery binds to, so the slot is occupied.
    // This is the one case the signing probe cannot backstop, so it is what
    // holds the certificate-read refusal in place.
    jest.spyOn(mock, 'readVaultPublicKey').mockResolvedValue({ publicKey: rec(3).pubkey })
    const generate = jest.spyOn(mock, 'generateVaultKey')

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'slot-occupied',
      details: { serial: 'MOCK-1' }
    })

    expect(generate).not.toHaveBeenCalled()
  })

  test('the slot probe refuses a slot only a signature can prove is occupied (the iOS case)', async () => {
    mock.occupySlot()
    preflightPasses()
    // YubiKit 4.4 cannot read retired-slot metadata: the read comes back empty
    // even though the slot holds a key that signs perfectly well.
    jest.spyOn(mock, 'readVaultPublicKey').mockResolvedValue(null)
    const generate = jest.spyOn(mock, 'generateVaultKey')

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'slot-occupied',
      details: { serial: 'MOCK-1' }
    })

    expect(generate).not.toHaveBeenCalled()
  })

  test('a YubiKey too old to prove its slots empty is refused by firmware, not by a slot message', async () => {
    // GET METADATA is firmware 5.3+. Below it every way to ask "is 0x82 empty"
    // is inferred from a status word, and 5.7.4 proved those move — an empty
    // retired slot that answered ATTEST 0x6A88 now answers 0x6A80. Enrollment
    // refuses to guess, and says why rather than reporting a phantom occupancy.
    jest.spyOn(mock, 'getKeyInfo').mockResolvedValue({ serial: 'MOCK-1', firmwareVersion: '5.2.7', pinRetries: 3 })
    const occupancy = jest.spyOn(mock, 'isVaultSlotOccupied')
    const generate = jest.spyOn(mock, 'generateVaultKey')

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'unsupported-platform',
      details: { serial: 'MOCK-1' }
    })

    expect(occupancy).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  test('a firmware at the 5.3 boundary is accepted', async () => {
    jest.spyOn(mock, 'getKeyInfo').mockResolvedValue({ serial: 'MOCK-1', firmwareVersion: '5.3.0', pinRetries: 3 })

    await expect(enrollKey(args())).resolves.toMatchObject({ serial: 'MOCK-1' })
  })

  test('the slot probe refuses a slot it cannot prove empty when the probe itself fails', async () => {
    // Both natives resolve ambiguity themselves now — GET METADATA fails closed,
    // so anything that is not an explicit REFERENCE DATA NOT FOUND arrives here
    // as occupied. What this pins is that JS does not second-guess that answer
    // and generate anyway.
    jest.spyOn(mock, 'isVaultSlotOccupied').mockResolvedValueOnce({ occupied: true })
    const generate = jest.spyOn(mock, 'generateVaultKey')

    const err = await enrollKey(args()).catch(e => e)
    expect(err).toMatchObject({ code: 'slot-occupied', details: { serial: 'MOCK-1' } })
    expect(err.message).toBe('Vault slot is not provably empty')
    expect(generate).not.toHaveBeenCalled()
  })

  test('a definite PIN rejection from the PIN change carries the serial', async () => {
    // Low-reachability (the same PIN verified moments earlier) and therefore
    // exactly the path that would never be caught in manual testing. The reset
    // offer must not have to guess which pin-invalid names a key.
    jest.spyOn(mock, 'changePin').mockRejectedValueOnce(new VaultError('pin-invalid', 'Wrong PIN', 2))

    await expect(enrollKey(args())).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2,
      details: { serial: 'MOCK-1' }
    })
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
    await finalizeEnrollment([enrolled, rec(2)], undefined, AUTHORITY)
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
  const salt = 'ab'.repeat(32)
  const instructions = (revision: number, keys: VaultKeyRecord[], over: Record<string, unknown> = {}) => ({
    v: 6 as const,
    type: 'R1C' as const,
    salt,
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
  test('the bounds are 2 and 5, with room for one replacement key beyond the lock', () => {
    expect(VAULT_MIN_KEYS).toBe(2)
    expect(VAULT_MAX_KEYS).toBe(5)
    expect(VAULT_MAX_ACTIVE_KEYS).toBe(6)
  })

  test('one record → not-enough-keys, nothing written', async () => {
    await expect(finalizeEnrollment([rec(1)], undefined, AUTHORITY)).rejects.toMatchObject({ code: 'not-enough-keys' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('six records → too-many-keys, nothing written', async () => {
    await expect(finalizeEnrollment([1, 2, 3, 4, 5, 6].map(rec), undefined, AUTHORITY)).rejects.toMatchObject({
      code: 'too-many-keys'
    })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('duplicate serials → key-already-enrolled (defensive: the wizard already refuses them)', async () => {
    const err = await finalizeEnrollment([rec(1), { ...rec(2), serial: rec(1).serial }], undefined, AUTHORITY).catch(
      e => e
    )
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: rec(1).serial })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('valid-looking public records cannot become deposit authority without ready challenge drafts', async () => {
    await expect(finalizeEnrollment([rec(1), rec(2)], undefined, AUTHORITY)).rejects.toMatchObject({
      code: 'key-not-adopted'
    })
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
    await expect(finalizeEnrollment([rec(1), rec(2)], wizardScope, AUTHORITY)).rejects.toMatchObject({
      code: 'scope-changed'
    })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('a vault already enrolled → key-already-enrolled naming an enrolled serial, the live key list untouched; with no vault it resolves', async () => {
    // Finish must never silently replace the key list that guards existing
    // deposits. The code is reused (no new locale copy); the serial lets the
    // wizard name a key it already knows.
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    await stageReady(rec(4))
    const err = await finalizeEnrollment([rec(3), rec(4)], undefined, AUTHORITY).catch(e => e)
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
    await finalizeEnrollment([a, b], undefined, AUTHORITY)
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

  // XR-001: SEC2-087 — a local storage attacker (no YubiKey, no wallet) who
  // can write the enrollment-draft SecureStore key used to inject a
  // structurally valid `ready` draft and have BOTH finalizeEnrollment and
  // addVaultKey commit it as deposit authority. These are exactly the shape
  // vaultKeyService.test.ts's own (pre-fix) finalizeReady/stageReady helpers
  // produced — the suite's own happy-path fixture WAS the attack primitive.
  test('XR-001: a ready draft written directly to storage (no live driver challenge, no wallet tag) is refused by finalizeEnrollment', async () => {
    const forged = rec(9)
    // The exact SEC2-087 attack primitive: preserveEnrollmentDraft called
    // directly with assurance 'ready' and NO tagger — no wallet.createHmac
    // ever ran for it, matching what a SecureStore-only attacker (who has no
    // wallet and no YubiKey) can produce.
    await vaultStore.preserveEnrollmentDraft({ record: forged, assurance: 'ready' }, vaultStore.captureScopeToken())
    // rec(2) gets a LEGITIMATE ready draft (real wallet-root tag) so this
    // test isolates the refusal to `forged`'s own missing tag — without
    // this, rec(2) has no draft at all and requireReadyEnrollmentDrafts
    // throws key-not-adopted for rec(2) alone regardless of whether forged's
    // tag is ever checked (SEC2-087 external review, XR-001 verification gap).
    await stageReady(rec(2))
    await expect(finalizeEnrollment([forged, rec(2)], undefined, AUTHORITY)).rejects.toMatchObject({
      code: 'key-not-adopted'
    })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('XR-001: a ready draft tagged by a DIFFERENT wallet is refused by finalizeEnrollment', async () => {
    const forged = rec(9)
    const scopeToken = vaultStore.captureScopeToken()
    const scope = vaultStore.getScope()!
    await vaultStore.preserveEnrollmentDraft({ record: forged, assurance: 'ready' }, scopeToken, r =>
      computeVaultDraftAuthorityTag(OTHER_WALLET, ADMIN, r, scope)
    )
    // rec(2) gets a LEGITIMATE ready draft (real wallet-root tag) so this
    // test isolates the refusal to `forged`'s wrong-wallet tag — see the
    // comment on the previous test for why an untagged rec(2) would make
    // this test pass regardless of whether forged's tag is ever checked.
    await stageReady(rec(2))
    await expect(finalizeEnrollment([forged, rec(2)], undefined, AUTHORITY)).rejects.toMatchObject({
      code: 'key-not-adopted'
    })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('XR-001: resumeEnrollmentDraft never fast-paths a forged ready draft — it falls through to a live challenge instead', async () => {
    const forged = rec(9)
    await vaultStore.preserveEnrollmentDraft({ record: forged, assurance: 'ready' }, vaultStore.captureScopeToken())
    // No card matching this forged serial is inserted, so the live-challenge
    // fallback (the only path left once the unverifiable fast path is
    // refused) fails exactly as an honest re-tap of the wrong card would —
    // proving the forged record was never simply handed back.
    await expect(
      resumeEnrollmentDraft({
        ...AUTHORITY,
        entry: { record: forged, assurance: 'ready' },
        onPhase: () => {},
        getPin: async () => PIN
      })
    ).rejects.toMatchObject({ code: 'serial-mismatch' })
  })
})

describe('addVaultKey / disableVault', () => {
  test('addVaultKey appends through vaultStore.addKey and returns the new meta', async () => {
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    const meta = await addVaultKey(rec(3), undefined, AUTHORITY)
    expect(meta.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  test('addVaultKey requires the exact ready draft produced by enrollment', async () => {
    await finalizeReady([rec(1), rec(2)])
    await expect(addVaultKey(rec(3), undefined, AUTHORITY)).rejects.toMatchObject({ code: 'key-not-adopted' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  test('XR-001: a ready draft written directly to storage (no live driver challenge, no wallet tag) is refused by addVaultKey', async () => {
    await finalizeReady([rec(1), rec(2)])
    const forged = rec(9)
    await vaultStore.preserveEnrollmentDraft({ record: forged, assurance: 'ready' }, vaultStore.captureScopeToken())
    await expect(addVaultKey(forged, undefined, AUTHORITY)).rejects.toMatchObject({ code: 'key-not-adopted' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  // Owner rule 2026-09-25: a full vault adds the replacement before removing
  // the key it replaces, so a sixth key is held (never locked to); a seventh
  // is refused.
  test('addVaultKey takes a sixth key on a full vault and refuses a seventh', async () => {
    await finalizeReady([1, 2, 3, 4, 5].map(rec))
    await stageReady(rec(6))
    await addVaultKey(rec(6), undefined, AUTHORITY)
    expect((await vaultStore.getMeta())!.keys.map(k => k.serial)).toEqual([1, 2, 3, 4, 5, 6].map(n => rec(n).serial))
    await expect(addVaultKey(rec(7), undefined, AUTHORITY)).rejects.toMatchObject({ code: 'too-many-keys' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(6)
  })

  test('addVaultKey refuses a duplicate serial and an unenrolled vault', async () => {
    await expect(addVaultKey(rec(1), undefined, AUTHORITY)).rejects.toMatchObject({ code: 'not-enrolled' })
    await finalizeReady([rec(1), rec(2)])
    await expect(addVaultKey({ ...rec(1), nickname: 'again' }, undefined, AUTHORITY)).rejects.toMatchObject({
      code: 'key-already-enrolled'
    })
  })

  test('an add-key wizard token cannot write into a wallet selected later', async () => {
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    const wizardScope = vaultStore.captureScopeToken()
    vaultStore.configureScope({ identityKey: '03' + 'cd'.repeat(32), chain: 'test' })
    await expect(addVaultKey(rec(3), wizardScope, AUTHORITY)).rejects.toMatchObject({ code: 'scope-changed' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('disableVault clears the key list', async () => {
    await finalizeReady([rec(1), rec(2)])
    await disableVault()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })

  // XR-002: SEC2-088 — a local storage attacker who can overwrite vaultStore's
  // scoped SecureStore record with a higher revision and a substituted key
  // set must not have that forgery "laundered" into a freshly, validly
  // tagged meta merely because the legitimate user's next action happens to
  // be addVaultKey (which only APPENDS to meta.keys — the attacker's
  // injected keys would otherwise remain live spend authority forever).
  test('XR-002: addVaultKey refuses to build on a forged, untagged local meta rather than laundering it', async () => {
    // A legitimately enrolled, correctly tagged vault…
    await finalizeReady([rec(1), rec(2)])
    // …then a SecureStore-only attacker overwrites it: same vaultId, a
    // strictly higher revision, and a substituted key set — vaultStore.setMeta
    // never touches the authority tag, so the on-file tag now belongs to
    // completely different content.
    const meta = (await vaultStore.getMeta())!
    const attackerKey = rec(666)
    await vaultStore.setMeta({ ...meta, revision: meta.revision + 5, keys: [attackerKey, rec(2)] })

    await stageReady(rec(3))
    await expect(addVaultKey(rec(3), undefined, AUTHORITY)).rejects.toMatchObject({ code: 'template-invalid' })
    // The forged key set was never committed further, and the legitimate
    // rec(3) key was never appended on top of it either. The on-file tag is
    // left exactly as finalizeReady wrote it — genuinely valid for the
    // ORIGINAL (pre-attack) content, which is exactly why it no longer
    // matches the attacker's substituted revision/keys.
    expect((await vaultStore.getMeta())!.keys).toEqual([attackerKey, rec(2)])
    const scope = vaultStore.getScope()!
    const staleTag = await vaultStore.getMetaTag()
    await expect(
      verifyVaultMetaAuthorityTag(FAKE_WALLET, ADMIN, { ...meta, revision: meta.revision + 5, keys: [attackerKey, rec(2)] }, scope, staleTag)
    ).resolves.toBe(false)
  })

  test('XR-002: addVaultKey proceeds normally when the existing meta is validly tagged (multiple local revision bumps, no outputs)', async () => {
    // The exact scenario the previous fix attempt's on-chain-ceiling approach
    // broke (69/195 transfers.test.ts failures): several legitimate local
    // key adds in a row with no intervening deposit. The wallet-root tag
    // (not an on-chain ceiling) is what distinguishes this from the forgery
    // above — every one of these writes is freshly, validly re-tagged.
    await finalizeReady([rec(1), rec(2)])
    await stageReady(rec(3))
    await addVaultKey(rec(3), undefined, AUTHORITY)
    await stageReady(rec(4))
    const meta = await addVaultKey(rec(4), undefined, AUTHORITY)
    expect(meta.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003', '10000004'])
    expect(await vaultStore.getMetaTag()).not.toBeNull()
  })
})
