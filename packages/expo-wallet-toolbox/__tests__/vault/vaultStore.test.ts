/**
 * vaultStore persistence tests — meta v5 (the enrolled key list) in
 * AsyncStorage. There is no seal any more: the only thing the store holds is
 * public data (serials, pubkeys, nicknames), and the legacy SecureStore seal
 * entry is removed by migrateLegacySeal.
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

const secureItems: Record<string, string> = {}
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async (k: string) => secureItems[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secureItems[k] = v
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete secureItems[k]
  })
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { vaultStore, VaultKeyRecord, VaultMetaV5 } from '../../core/services/vault/vaultStore'

const key = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: 0x82,
  pubkey: '02' + n.toString(16).padStart(2, '0').repeat(32),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

const META: VaultMetaV5 = {
  v: 5,
  createdAt: 1_700_000_000_000,
  keys: [key(1), key(2)]
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
  ;(SecureStore.deleteItemAsync as jest.Mock).mockClear()
})

describe('vaultStore v5', () => {
  it('round-trips v5 meta and reports enrolled on meta alone', async () => {
    expect(await vaultStore.isEnrolled()).toBe(false)
    await vaultStore.setMeta(META)
    expect(await vaultStore.getMeta()).toEqual(META)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })

  it('reads a v4 record as not enrolled', async () => {
    // Spec §3.2 / §8: a device holding the K1-era v4 meta shows "not enrolled"
    // and can enrol fresh. Written through AsyncStorage directly — the store
    // exposes no raw-write seam just for tests.
    await AsyncStorage.setItem(
      'vault_meta_v1',
      JSON.stringify({ v: 4, enrolledAt: 1, yubiSerial: 's', nickname: 'n', slot: 0x82, nextKeyIndex: 3 })
    )
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  it('reads a v5 record without a keys array as not enrolled', async () => {
    await AsyncStorage.setItem('vault_meta_v1', JSON.stringify({ v: 5, createdAt: 1 }))
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('reads unparseable JSON as not enrolled', async () => {
    await AsyncStorage.setItem('vault_meta_v1', '{not json')
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('addKey appends and persists, returning the new meta', async () => {
    await vaultStore.setMeta(META)
    const next = await vaultStore.addKey(key(3))
    expect(next.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  it('addKey refuses a duplicate serial with key-already-enrolled', async () => {
    await vaultStore.setMeta(META)
    const err = await vaultStore.addKey({ ...key(1), nickname: 'again' }).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: key(1).serial })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  it('addKey refuses a sixth key with too-many-keys', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3), key(4), key(5)] })
    await expect(vaultStore.addKey(key(6))).rejects.toMatchObject({ code: 'too-many-keys' })
  })

  it('addKey with no meta throws not-enrolled', async () => {
    await expect(vaultStore.addKey(key(1))).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  it('removeKey drops the serial and clears lastUsedSerial when it pointed at it', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)], lastUsedSerial: '10000003', lastUsedAt: 5 })
    const next = await vaultStore.removeKey('10000003')
    expect(next.keys.map(k => k.serial)).toEqual(['10000001', '10000002'])
    expect(next.lastUsedSerial).toBeUndefined()
    expect(next.lastUsedAt).toBe(5)
  })

  it('removeKey refuses to go below two keys with last-keys', async () => {
    await vaultStore.setMeta(META)
    await expect(vaultStore.removeKey('10000001')).rejects.toMatchObject({ code: 'last-keys' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  it('removeKey of an unknown serial throws not-enrolled and changes nothing', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await expect(vaultStore.removeKey('nope')).rejects.toMatchObject({ code: 'not-enrolled' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  it('renameKey changes only the nickname', async () => {
    await vaultStore.setMeta(META)
    const next = await vaultStore.renameKey('10000002', 'Safe')
    expect(next.keys[1]).toEqual({ ...key(2), nickname: 'Safe' })
    expect(next.keys[0]).toEqual(key(1))
  })

  it('noteLastUsed stamps serial and time, and is a no-op with no meta', async () => {
    await vaultStore.noteLastUsed('10000001') // nothing enrolled yet
    expect(await vaultStore.getMeta()).toBeNull()

    await vaultStore.setMeta(META)
    const before = Date.now()
    await vaultStore.noteLastUsed('10000002')
    const meta = (await vaultStore.getMeta())!
    expect(meta.lastUsedSerial).toBe('10000002')
    expect(meta.lastUsedAt).toBeGreaterThanOrEqual(before)
  })

  it('migrateLegacySeal deletes the SecureStore seal and swallows errors', async () => {
    secureItems['vault_seal_v1'] = 'legacy-sealed-blob'
    await vaultStore.migrateLegacySeal()
    expect(secureItems['vault_seal_v1']).toBeUndefined()

    ;(SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(vaultStore.migrateLegacySeal()).resolves.toBeUndefined()
  })

  it('clear() removes the meta (and any legacy seal) so isEnrolled is false', async () => {
    await vaultStore.setMeta(META)
    secureItems['vault_seal_v1'] = 'legacy'
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(secureItems['vault_seal_v1']).toBeUndefined()
  })
})
