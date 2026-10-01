import { HD, Mnemonic } from '@bsv/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { discoverProfiles, registerDiscoveredProfile, type ProfileProbe } from '../../core/profiles/discovery'
import type { BackupChain } from '../../core/backup/constants'
import {
  __resetProfilesForTests,
  appendProfile,
  getProfilesState,
  updateProfile
} from '../../core/profiles/profileStore'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hd = HD.fromSeed(Mnemonic.fromString(MNEMONIC).toSeed(''))
const keyHex = (n: number) => Buffer.from(hd.derive(`m/0'/${n}'`).privKey.toArray()).toString('hex')

/** A backup server holding `backups[n] = chains` for profile n. */
function fakeProbe(backups: Record<number, BackupChain[]>, failAt?: number): { probe: ProfileProbe; asked: number[] } {
  const byKey = new Map<string, number>()
  for (let n = 0; n < 60; n++) byKey.set(keyHex(n), n)
  const asked: number[] = []
  const probe: ProfileProbe = async (primaryKey, chain) => {
    const n = byKey.get(Buffer.from(primaryKey).toString('hex'))!
    if (!asked.includes(n)) asked.push(n)
    if (n === failAt) throw new Error('offline')
    return (backups[n] ?? []).includes(chain)
  }
  return { probe, asked }
}

async function run(
  backups: Record<number, BackupChain[]>,
  opts: { failAt?: number; maxProfiles?: number; skip?: (index: number) => boolean } = {}
) {
  const { probe, asked } = fakeProbe(backups, opts.failAt)
  const registered: Array<[number, string]> = []
  const count = await discoverProfiles({
    mnemonic: MNEMONIC,
    probe,
    register: async (i, net) => {
      registered.push([i, net])
    },
    maxProfiles: opts.maxProfiles,
    skip: opts.skip
  })
  return { count, registered, asked }
}

test('registers consecutive backed-up profiles and stops at the first miss', async () => {
  const r = await run({ 1: ['main'], 2: ['test'], 4: ['main'] })
  expect(r.registered).toEqual([
    [1, 'main'],
    [2, 'test']
  ])
  expect(r.count).toBe(2)
  expect(r.asked).toEqual([1, 2, 3])
})

test('prefers mainnet when a profile has backups on several networks', async () => {
  expect((await run({ 1: ['teratest', 'main'] })).registered).toEqual([[1, 'main']])
  expect((await run({ 1: ['teratest', 'test'] })).registered).toEqual([[1, 'test']])
})

test('nothing backed up → nothing registered', async () => {
  expect((await run({})).count).toBe(0)
})

test('a probe error stops discovery and keeps what was found', async () => {
  const r = await run({ 1: ['main'], 2: ['main'], 3: ['main'] }, { failAt: 2 })
  expect(r.registered).toEqual([[1, 'main']])
})

test('maxProfiles bounds the search', async () => {
  const all: Record<number, BackupChain[]> = {}
  for (let n = 1; n < 60; n++) all[n] = ['main']
  const r = await run(all, { maxProfiles: 3 })
  expect(r.registered.map(([i]) => i)).toEqual([1, 2, 3])
})

test('a skipped (removed) index is neither probed nor registered, and does not end the search', async () => {
  // Profile 2 was removed here and has no backup; 1 and 3 are live and backed up.
  const r = await run({ 1: ['main'], 3: ['test'] }, { skip: i => i === 2 })
  expect(r.registered).toEqual([
    [1, 'main'],
    [3, 'test']
  ])
  expect(r.asked).toEqual([1, 3, 4])
  expect(r.count).toBe(2)
})

test('skipping an index that does have a backup still leaves it alone', async () => {
  const r = await run({ 1: ['main'], 2: ['main'] }, { skip: i => i === 1 })
  expect(r.registered).toEqual([[2, 'main']])
  expect(r.asked).toEqual([2, 3])
})

describe('registerDiscoveredProfile', () => {
  beforeEach(async () => {
    __resetProfilesForTests()
    await AsyncStorage.clear()
  })

  test('appends the next index as a profile awaiting restore', async () => {
    await registerDiscoveredProfile(1, 'test')
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'test', needsRestore: true })
  })

  test('is idempotent: an index already registered is left as it is', async () => {
    await registerDiscoveredProfile(1, 'test')
    await updateProfile(1, { needsRestore: false, network: 'main' })
    await registerDiscoveredProfile(1, 'test')
    expect(getProfilesState().profiles).toHaveLength(2)
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'main' })
  })

  test('a tombstoned index stays removed and keeps its slot', async () => {
    await appendProfile()
    await updateProfile(1, { identityKey: '02ab', deleted: true })
    await registerDiscoveredProfile(1, 'main')
    expect(getProfilesState().profiles).toHaveLength(2)
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'main', identityKey: '02ab', deleted: true })
  })

  test('the index after a tombstone still registers, as the next slot', async () => {
    await appendProfile()
    await updateProfile(1, { deleted: true })
    await registerDiscoveredProfile(2, 'main')
    expect(getProfilesState().profiles.map(p => [p.index, !!p.deleted])).toEqual([
      [0, false],
      [1, true],
      [2, false]
    ])
    expect(getProfilesState().profiles[2].needsRestore).toBe(true)
  })

  test('an index beyond the next slot is not registered (the list stays dense)', async () => {
    await registerDiscoveredProfile(3, 'main')
    expect(getProfilesState().profiles).toHaveLength(1)
  })
})
