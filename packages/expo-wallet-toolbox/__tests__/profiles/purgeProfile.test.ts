/**
 * What a removed profile leaves behind on this device, and the sweep that takes
 * it away: its databases on every network, its ARC token, and the AsyncStorage
 * keys that end in exactly its own `__p<n>` suffix. The same function runs once
 * after a removal and again on every launch, so it has to be idempotent and
 * must never reach another profile's keys — profile 0's are bare, and `__p1` is
 * a prefix of `__p10`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { fake as secureStoreFake } from '../__mocks__/secureStoreFake'
import { arcApiTokenStorageKey } from '../../core/constants'
import { clearArcApiTokensForProfile } from '../../core/services/arcTokenStorage'
import { purgeProfile, purgeRemovedProfiles, type PurgeProfileIo } from '../../core/profiles/purgeProfile'
import type { ProfileRecord } from '../../core/profiles/profileStore'

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

const IDENTITY = '02' + 'ab'.repeat(32)
const OTHER_IDENTITY = '03' + 'cd'.repeat(32)

function fakeIo(keys: string[] = []) {
  const stored = new Set(keys)
  const calls: string[] = []
  const io: PurgeProfileIo = {
    purgeDbFiles: jest.fn(async (suffix: string) => {
      calls.push(`db:${suffix}`)
    }),
    clearArcTokens: jest.fn(async (index: number) => {
      calls.push(`arc:${index}`)
    }),
    getAllKeys: jest.fn(async () => [...stored]),
    removeKeys: jest.fn(async (toRemove: string[]) => {
      calls.push(`keys:${toRemove.join(',')}`)
      toRemove.forEach(k => stored.delete(k))
    })
  }
  return { io, calls, stored }
}

describe('purgeProfile', () => {
  it("purges the identity's databases by the last eight characters of its key, its ARC token and its keys", async () => {
    const { io, calls } = fakeIo(['avatar__p3'])
    expect(await purgeProfile({ index: 3, identityKey: IDENTITY }, io)).toBe(true)
    expect(calls).toEqual([`db:${IDENTITY.slice(-8)}`, 'arc:3', 'keys:avatar__p3'])
  })

  it('removes only keys that end in exactly this profile’s suffix', async () => {
    const { io, stored } = fakeIo([
      'wallet_user_avatar_icon', // profile 0 — bare
      'wallet_user_avatar_icon__p1',
      'connections__p1',
      'connections__p10', // __p1 is a prefix of __p10
      'connections__p11',
      'connections__p21',
      'cached_wallet_balance_main__p2',
      'wallet_profiles_v1',
      'backupPushEnabled__p1'
    ])
    await purgeProfile({ index: 1, identityKey: IDENTITY }, io)
    expect([...stored].sort()).toEqual(
      [
        'wallet_user_avatar_icon',
        'connections__p10',
        'connections__p11',
        'connections__p21',
        'cached_wallet_balance_main__p2',
        'wallet_profiles_v1'
      ].sort()
    )
  })

  it('does not touch the key store when there is nothing to remove', async () => {
    const { io } = fakeIo(['connections__p2'])
    await purgeProfile({ index: 1, identityKey: IDENTITY }, io)
    expect(io.removeKeys).not.toHaveBeenCalled()
  })

  it('never purges profile 0, whose keys are the bare ones', async () => {
    const { io, calls, stored } = fakeIo(['connections', 'connections__p1'])
    expect(await purgeProfile({ index: 0, identityKey: IDENTITY }, io)).toBe(false)
    expect(calls).toEqual([])
    expect([...stored]).toEqual(['connections', 'connections__p1'])
  })

  it('refuses an index that is not a positive integer', async () => {
    const { io, calls } = fakeIo(['connections__p1'])
    expect(await purgeProfile({ index: -1, identityKey: IDENTITY }, io)).toBe(false)
    expect(await purgeProfile({ index: 1.5, identityKey: IDENTITY }, io)).toBe(false)
    expect(calls).toEqual([])
  })

  it('has no databases to purge for a profile whose identity was never recorded, and still sweeps the rest', async () => {
    const { io, calls } = fakeIo(['connections__p2'])
    expect(await purgeProfile({ index: 2 }, io)).toBe(true)
    expect(io.purgeDbFiles).not.toHaveBeenCalled()
    expect(calls).toEqual(['arc:2', 'keys:connections__p2'])
  })

  it('a step that throws does not stop the others, and the result says it was not clean', async () => {
    const { io, calls } = fakeIo(['connections__p1'])
    io.purgeDbFiles = jest.fn(async () => {
      throw new Error('registry unreadable')
    })
    io.clearArcTokens = jest.fn(async () => {
      throw new Error('secure store locked')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await purgeProfile({ index: 1, identityKey: IDENTITY }, io)).toBe(false)
    expect(calls).toEqual(['keys:connections__p1'])
    jest.restoreAllMocks()
  })

  it('a key list that cannot be read is not clean, and the earlier steps still ran', async () => {
    const { io, calls } = fakeIo()
    io.getAllKeys = jest.fn(async () => {
      throw new Error('storage unavailable')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await purgeProfile({ index: 1, identityKey: IDENTITY }, io)).toBe(false)
    expect(calls).toEqual([`db:${IDENTITY.slice(-8)}`, 'arc:1'])
    jest.restoreAllMocks()
  })

  it('is idempotent: a second run finds nothing and says clean', async () => {
    const { io, calls } = fakeIo(['connections__p1'])
    await purgeProfile({ index: 1, identityKey: IDENTITY }, io)
    calls.length = 0
    expect(await purgeProfile({ index: 1, identityKey: IDENTITY }, io)).toBe(true)
    expect(calls).toEqual([`db:${IDENTITY.slice(-8)}`, 'arc:1'])
  })
})

describe('purgeRemovedProfiles (the startup retry)', () => {
  const profiles: ProfileRecord[] = [
    { index: 0, network: 'main', identityKey: OTHER_IDENTITY },
    { index: 1, network: 'main', identityKey: IDENTITY, deleted: true },
    { index: 2, network: 'test' },
    { index: 3, network: 'main', deleted: true },
    { index: 4, network: 'main', identityKey: OTHER_IDENTITY }
  ]

  it('purges every tombstone and nothing else', async () => {
    const { io, calls } = fakeIo(['x__p1', 'x__p2', 'x__p3', 'x__p4', 'x'])
    await purgeRemovedProfiles(profiles, io)
    expect(calls).toEqual([`db:${IDENTITY.slice(-8)}`, 'arc:1', 'keys:x__p1', 'arc:3', 'keys:x__p3'])
  })

  it('does nothing at all when no profile was removed', async () => {
    const { io } = fakeIo(['x__p1'])
    await purgeRemovedProfiles(
      profiles.filter(p => !p.deleted),
      io
    )
    expect(io.getAllKeys).not.toHaveBeenCalled()
    expect(io.purgeDbFiles).not.toHaveBeenCalled()
  })

  it('a failure on one tombstone does not stop the next', async () => {
    const { io, calls } = fakeIo(['x__p1', 'x__p3'])
    let first = true
    io.purgeDbFiles = jest.fn(async () => {
      if (first) {
        first = false
        throw new Error('boom')
      }
    })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await purgeRemovedProfiles(profiles, io)
    expect(calls).toEqual(['arc:1', 'keys:x__p1', 'arc:3', 'keys:x__p3'])
    jest.restoreAllMocks()
  })
})

describe('against the real ARC token store', () => {
  // The io the app wires: the real clearArcApiTokensForProfile on the SecureStore fake.
  it('clears this profile’s token on every network and leaves the others', async () => {
    secureStoreFake.__reset()
    await AsyncStorage.clear()
    for (const net of ['main', 'test']) {
      await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey(net)}__p1`, 'p1-token', undefined)
      await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey(net)}__p2`, 'p2-token', undefined)
      await secureStoreFake.setItemAsync(arcApiTokenStorageKey(net), 'p0-token', undefined)
    }
    const { io } = fakeIo()
    await purgeProfile({ index: 1 }, { ...io, clearArcTokens: clearArcApiTokensForProfile })
    expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p1`)).toBeUndefined()
    expect(secureStoreFake.__get(`${arcApiTokenStorageKey('test')}__p1`)).toBeUndefined()
    expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p2`)).toBe('p2-token')
    expect(secureStoreFake.__get(arcApiTokenStorageKey('main'))).toBe('p0-token')
  })
})
