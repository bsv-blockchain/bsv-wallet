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
jest.mock('expo-secure-store', () => {
  const store: Record<string, string> = {}
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo',
    getItemAsync: async (k: string) => store[k] ?? null,
    setItemAsync: async (k: string, v: string) => {
      store[k] = v
    },
    deleteItemAsync: async (k: string) => {
      delete store[k]
    },
    __clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { vaultStore, VaultKeyRecord, VaultMetaV6 } from '../../core/services/vault/vaultStore'

const ID_A = '02' + 'ab'.repeat(32)
const ID_B = '03' + 'cd'.repeat(32)

const key = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.Point.BASE.multiply(BigInt(n)).toBytes(true))),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

const META: VaultMetaV6 = {
  v: 6,
  vaultId: '11'.repeat(32),
  revision: 1,
  createdAt: 1_700_000_000_000,
  keys: [key(1), key(2)]
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
})

afterEach(() => vaultStore.clearScope())

describe('vaultStore v6', () => {
  it('round-trips strict metadata in the configured wallet+chain namespace', async () => {
    expect(await vaultStore.isEnrolled()).toBe(false)
    await vaultStore.setMeta(META)
    expect(await vaultStore.getMeta()).toEqual(META)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })

  it('isolates the same wallet across chains and different wallets on one chain', async () => {
    await vaultStore.setMeta(META)

    vaultStore.configureScope({ identityKey: ID_A, chain: 'test' })
    expect(await vaultStore.getMeta()).toBeNull()
    const testMeta = { ...META, vaultId: '22'.repeat(32) }
    await vaultStore.setMeta(testMeta)

    vaultStore.configureScope({ identityKey: ID_B, chain: 'main' })
    expect(await vaultStore.getMeta()).toBeNull()

    vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
    expect(await vaultStore.getMeta()).toEqual(META)
    vaultStore.configureScope({ identityKey: ID_A, chain: 'test' })
    expect(await vaultStore.getMeta()).toEqual(testMeta)
  })

  it('has no authority while unscoped and refuses unscoped writes', async () => {
    await vaultStore.setMeta(META)
    vaultStore.clearScope()
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
    await expect(vaultStore.setMeta(META)).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  it('keeps generated-key drafts non-authoritative and in their captured scope after a switch', async () => {
    const tokenA = vaultStore.captureScopeToken()
    await vaultStore.preserveEnrollmentDraft(
      { record: key(1), assurance: 'management-uncertain' },
      tokenA
    )
    expect(await vaultStore.getMeta()).toBeNull()

    vaultStore.configureScope({ identityKey: ID_B, chain: 'test' })
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
    await vaultStore.preserveEnrollmentDraft({ record: key(1), assurance: 'challenge-required' }, tokenA)
    expect(await vaultStore.getMeta()).toBeNull()

    vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([
      { record: key(1), assurance: 'challenge-required' }
    ])
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('advances draft assurance monotonically and consumes it only after an authority write', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.preserveEnrollmentDraft({ record: key(1), assurance: 'ready' }, token)
    await vaultStore.preserveEnrollmentDraft({ record: key(1), assurance: 'management-uncertain' }, token)
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([{ record: key(1), assurance: 'ready' }])
    expect(await vaultStore.getMeta()).toBeNull()

    await vaultStore.setMeta(META, token)
    await vaultStore.consumeEnrollmentDrafts([key(1).serial], token)
    expect(await vaultStore.getEnrollmentDrafts()).toEqual([])
    expect(await vaultStore.getMeta()).toEqual(META)
  })

  it('durably quarantines pre-key credential changes without storing secrets', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.preserveEnrollmentQuarantine(key(1).serial, 'pin-change-uncertain', token)
    await vaultStore.transitionEnrollmentQuarantine(key(1).serial, 'pin-change-uncertain', 'pin-changed', token)
    await vaultStore.transitionEnrollmentQuarantine(key(1).serial, 'pin-changed', 'puk-change-uncertain', token)
    await vaultStore.transitionEnrollmentQuarantine(key(1).serial, 'puk-change-uncertain', 'puk-changed', token)
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: key(1).serial, stage: 'puk-changed' })
    ])
    const raw = await SecureStore.getItemAsync(`vault_enrollment_draft_v1_main_${ID_A}`)
    expect(raw).not.toContain('123456')
    expect(raw).not.toContain('12345678')

    // Once a public record exists it replaces the serial-only quarantine with
    // the stronger stage-aware recovery handle.
    await vaultStore.preserveEnrollmentDraft({ record: key(1), assurance: 'management-uncertain' }, token)
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([])
  })

  it('advances only the exact crash-consistency quarantine stage', async () => {
    const token = vaultStore.captureScopeToken()
    await vaultStore.preserveEnrollmentQuarantine(key(1).serial, 'puk-change-uncertain', token)
    await expect(
      vaultStore.transitionEnrollmentQuarantine(key(1).serial, 'pin-change-uncertain', 'pin-changed', token)
    ).rejects.toMatchObject({ code: 'template-invalid' })
    await vaultStore.transitionEnrollmentQuarantine(key(1).serial, 'puk-change-uncertain', 'puk-changed', token)
    expect(await vaultStore.getEnrollmentQuarantines()).toEqual([
      expect.objectContaining({ serial: key(1).serial, stage: 'puk-changed' })
    ])
  })

  it.each([
    { ...META, v: 5 },
    { ...META, vaultId: 'ABC' },
    { ...META, revision: 0 },
    { ...META, keys: [key(1)] },
    { ...META, keys: [key(1), { ...key(2), pubkey: key(1).pubkey }] },
    { ...META, keys: [key(1), { ...key(2), serial: key(1).serial }] },
    { ...META, keys: [key(1), { ...key(2), pubkey: '02' + 'ff'.repeat(32) }] },
    { ...META, extra: true }
  ])('rejects corrupt or non-v6 metadata rather than treating it as authority', async bad => {
    const storageKey = `vault_meta_v6_main_${ID_A}`
    await SecureStore.setItemAsync(storageKey, JSON.stringify(bad))
    await expect(vaultStore.getMeta()).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(vaultStore.clear()).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(vaultStore.setMeta(bad as any)).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('restores only verified current-or-newer metadata for the same enrollment', async () => {
    await vaultStore.restoreVerifiedMeta(META)
    await expect(vaultStore.restoreVerifiedMeta({ ...META, keys: [key(1), key(3)] })).rejects.toMatchObject({
      code: 'template-invalid'
    })
    await expect(
      vaultStore.restoreVerifiedMeta({ ...META, revision: 2, createdAt: META.createdAt + 1 })
    ).rejects.toMatchObject({
      code: 'template-invalid'
    })
    const newer = { ...META, revision: 2, keys: [key(1), key(2), key(3)] }
    await vaultStore.restoreVerifiedMeta(newer)
    expect(await vaultStore.getMeta()).toEqual({
      ...newer,
      recovery: { required: true, adoptedSerials: [] }
    })
    await expect(vaultStore.restoreVerifiedMeta(META)).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(vaultStore.restoreVerifiedMeta({ ...newer, vaultId: '22'.repeat(32) })).rejects.toMatchObject({
      code: 'template-invalid'
    })
  })

  it('cannot erase local security state by replaying same-revision recovery metadata', async () => {
    const pending = {
      key: key(3),
      keyIndex: 2,
      startedAt: 1_700_000_000_100,
      revision: 2,
      state: 'broadcast' as const
    }
    const current: VaultMetaV6 = {
      ...META,
      revision: 2,
      lastUsedAt: 1_700_000_000_200,
      lastUsedSerial: key(1).serial,
      pendingRemoval: pending,
      recovery: { required: true, adoptedSerials: [key(1).serial] }
    }
    await vaultStore.setMeta(current)

    await vaultStore.restoreVerifiedMeta({ ...META, revision: 2 })

    expect(await vaultStore.getMeta()).toEqual(current)
  })

  it('merges same-revision removal evidence and rejects a different removal', async () => {
    const current: VaultMetaV6 = {
      ...META,
      revision: 2,
      pendingRemoval: {
        key: key(3),
        keyIndex: 2,
        startedAt: 1_700_000_000_200,
        revision: 2,
        state: 'prepared'
      }
    }
    await vaultStore.setMeta(current)
    await vaultStore.restoreVerifiedMeta({
      ...META,
      revision: 2,
      pendingRemoval: {
        ...current.pendingRemoval!,
        startedAt: 1_700_000_000_100,
        state: 'broadcast'
      }
    })
    expect((await vaultStore.getMeta())!.pendingRemoval).toEqual({
      ...current.pendingRemoval,
      startedAt: 1_700_000_000_100,
      state: 'broadcast'
    })

    await expect(
      vaultStore.restoreVerifiedMeta({
        ...META,
        revision: 2,
        pendingRemoval: {
          key: key(4),
          keyIndex: 2,
          startedAt: 1_700_000_000_300,
          revision: 2,
          state: 'prepared'
        }
      })
    ).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('addKey increments the revision and rejects duplicate serials or pubkeys', async () => {
    await vaultStore.setMeta(META)
    const next = await vaultStore.addKey(key(3))
    expect(next.revision).toBe(2)
    expect(next.keys).toHaveLength(3)
    await expect(vaultStore.addKey({ ...key(4), pubkey: key(1).pubkey })).rejects.toMatchObject({
      code: 'key-already-enrolled'
    })
  })

  it('begins removal by excluding the key and retaining a durable tombstone', async () => {
    await vaultStore.setMeta({
      ...META,
      keys: [key(1), key(2), key(3)],
      lastUsedSerial: key(3).serial,
      lastUsedAt: 5
    })
    const next = await vaultStore.beginKeyRemoval(key(3).serial)
    expect(next.revision).toBe(2)
    expect(next.lastUsedSerial).toBeUndefined()
    expect(next.lastUsedAt).toBeUndefined()
    expect(next.keys.map(k => k.serial)).toEqual([key(1).serial, key(2).serial])
    expect(next.pendingRemoval).toMatchObject({
      key: key(3),
      keyIndex: 2,
      revision: 2,
      state: 'prepared'
    })
  })

  it('keeps removal state bounded and finalizes only after broadcast proof', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await vaultStore.beginKeyRemoval(key(2).serial)
    await expect(vaultStore.finalizeProvenKeyRemoval()).rejects.toMatchObject({
      code: 'template-invalid'
    })
    await vaultStore.markKeyRemovalBroadcast()
    await vaultStore.markKeyRemovalBroadcast() // idempotent
    expect(await vaultStore.getMeta()).toMatchObject({ pendingRemoval: { state: 'broadcast' } })
    expect(JSON.stringify(await vaultStore.getMeta())).not.toContain('txids')
    const done = await vaultStore.finalizeProvenKeyRemoval()
    expect(done.pendingRemoval).toBeUndefined()
    expect(done.keys.map(k => k.serial)).toEqual([key(1).serial, key(3).serial])
  })

  it('finalizes an empty-vault removal only before any relock transaction is recorded', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await vaultStore.beginKeyRemoval(key(2).serial)
    const done = await vaultStore.finalizeEmptyKeyRemoval()
    expect(done.pendingRemoval).toBeUndefined()

    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await vaultStore.beginKeyRemoval(key(2).serial)
    await vaultStore.markKeyRemovalBroadcast()
    await expect(vaultStore.finalizeEmptyKeyRemoval()).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('can cancel only a definitely unbroadcast removal and restores key order', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await vaultStore.beginKeyRemoval(key(2).serial)
    const restored = await vaultStore.cancelUnbroadcastKeyRemoval()
    expect(restored.keys).toEqual([key(1), key(2), key(3)])
    expect(restored.revision).toBe(3)

    await vaultStore.beginKeyRemoval(key(2).serial)
    await vaultStore.markKeyRemovalBroadcast()
    await expect(vaultStore.cancelUnbroadcastKeyRemoval()).rejects.toMatchObject({ code: 'relock-required' })
  })

  it('enforces minimum and maximum key counts', async () => {
    await vaultStore.setMeta(META)
    await expect(vaultStore.beginKeyRemoval(key(1).serial)).rejects.toMatchObject({ code: 'last-keys' })
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3), key(4), key(5)] })
    await expect(vaultStore.addKey(key(6))).rejects.toMatchObject({ code: 'too-many-keys' })
  })

  it('rename and last-used updates validate their target', async () => {
    await vaultStore.setMeta(META)
    const renamed = await vaultStore.renameKey(key(2).serial, ' Safe ')
    expect(renamed.keys[1].nickname).toBe('Safe')
    expect(renamed.revision).toBe(2)
    await expect(vaultStore.renameKey('missing', 'Name')).rejects.toMatchObject({ code: 'not-enrolled' })
    await expect(vaultStore.renameKey(key(1).serial, ' '.repeat(2))).rejects.toMatchObject({ code: 'template-invalid' })
    await vaultStore.noteLastUsed('missing')
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBeUndefined()
    await vaultStore.noteLastUsed(key(1).serial)
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBe(key(1).serial)
  })

  it('clear removes only the active scope', async () => {
    await vaultStore.setMeta(META)
    vaultStore.configureScope({ identityKey: ID_A, chain: 'test' })
    await vaultStore.setMeta({ ...META, vaultId: '22'.repeat(32) })
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()
    vaultStore.configureScope({ identityKey: ID_A, chain: 'main' })
    expect(await vaultStore.getMeta()).toEqual(META)
  })

  it('serializes read-modify-write mutations so a later update cannot erase an earlier one', async () => {
    await vaultStore.setMeta(META)
    const realGet = SecureStore.getItemAsync.bind(SecureStore)
    let releaseRead!: (value: string | null) => void
    const getSpy = jest.spyOn(SecureStore, 'getItemAsync').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseRead = resolve
        })
    )

    const note = vaultStore.noteLastUsed(key(1).serial)
    await Promise.resolve()
    const add = vaultStore.addKey(key(3))
    await Promise.resolve()
    // addKey is queued behind noteLastUsed, so it cannot read the old record.
    expect(getSpy).toHaveBeenCalledTimes(1)
    releaseRead(JSON.stringify(META))
    await Promise.all([note, add])
    getSpy.mockRestore()

    const final = await vaultStore.getMeta()
    expect(final?.keys.map(k => k.serial)).toEqual([key(1).serial, key(2).serial, key(3).serial])
    expect(final?.lastUsedSerial).toBe(key(1).serial)
    expect(final?.revision).toBe(2)
  })

  it('never lets a late mutation write wallet A metadata into wallet B', async () => {
    await vaultStore.setMeta(META)
    const realGet = SecureStore.getItemAsync.bind(SecureStore)
    let releaseRead!: (value: string | null) => void
    const getSpy = jest.spyOn(SecureStore, 'getItemAsync').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseRead = resolve
        })
    )

    const lateAdd = vaultStore.addKey(key(3))
    const rejected = expect(lateAdd).rejects.toMatchObject({ code: 'scope-changed' })
    await Promise.resolve()

    vaultStore.configureScope({ identityKey: ID_B, chain: 'test' })
    const walletB = { ...META, vaultId: '33'.repeat(32) }
    const writeB = vaultStore.setMeta(walletB)
    releaseRead(JSON.stringify(META))
    await rejected
    await writeB
    getSpy.mockRestore()

    expect(await realGet(`vault_meta_v6_test_${ID_B}`)).toBe(JSON.stringify(walletB))
    expect(await vaultStore.getMeta()).toEqual(walletB)
  })

  it('ignores an attacker-controlled AsyncStorage vault record', async () => {
    const attacker = { ...META, vaultId: '44'.repeat(32), keys: [key(4), key(5)] }
    await AsyncStorage.setItem(`vault_meta_v6_main_${ID_A}`, JSON.stringify(attacker))
    expect(await vaultStore.getMeta()).toBeNull()
    await vaultStore.setMeta(META)
    expect(await vaultStore.getMeta()).toEqual(META)
  })
})
