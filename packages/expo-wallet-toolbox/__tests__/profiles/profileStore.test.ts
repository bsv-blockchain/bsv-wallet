import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  PROFILES_STORAGE_KEY,
  PROFILE_KEY_SUFFIX_RE,
  __resetProfilesForTests,
  appendProfile,
  defaultProfilesState,
  getActiveProfile,
  getActiveProfileIndex,
  getProfilesState,
  liveProfiles,
  loadProfiles,
  normalizeProfileName,
  parseProfilesState,
  profileScopedKey,
  resetProfiles,
  setActiveProfile,
  subscribeProfiles,
  updateProfile
} from '../../core/profiles/profileStore'

beforeEach(async () => {
  __resetProfilesForTests()
  await AsyncStorage.clear()
})

describe('parseProfilesState', () => {
  test('empty → single mainnet profile 0', () => {
    expect(parseProfilesState(null)).toEqual({ active: 0, profiles: [{ index: 0, network: 'main' }] })
  })

  test.each(['{', '"x"', 'null', '{"profiles":"no"}', '{"active":0,"profiles":[]}'])('corrupt %p → default', raw => {
    expect(parseProfilesState(raw)).toEqual(defaultProfilesState())
  })

  test('out-of-range active clamps to 0', () => {
    const raw = JSON.stringify({
      active: 5,
      profiles: [
        { index: 0, network: 'main' },
        { index: 1, network: 'test' }
      ]
    })
    expect(parseProfilesState(raw).active).toBe(0)
  })

  test('unsorted, duplicated, gapped lists normalise to dense 0..n-1', () => {
    const raw = JSON.stringify({
      active: 1,
      profiles: [
        { index: 1, network: 'test' },
        { index: 0, network: 'main' },
        { index: 1, network: 'teratest' },
        { index: 3, network: 'main' }
      ]
    })
    expect(parseProfilesState(raw)).toEqual({
      active: 1,
      profiles: [
        { index: 0, network: 'main' },
        { index: 1, network: 'test' }
      ]
    })
  })

  test('unknown network falls back to the default chain; extra fields kept only when valid', () => {
    const raw = JSON.stringify({
      active: 0,
      profiles: [{ index: 0, network: 'moon', identityKey: 'ab', needsRestore: 'yes' }]
    })
    expect(parseProfilesState(raw).profiles[0]).toEqual({ index: 0, network: 'main', identityKey: 'ab' })
  })
})

describe('parseProfilesState: name and tombstone', () => {
  const three = (over: Record<string, unknown>[]) =>
    JSON.stringify({
      active: 0,
      profiles: [
        { index: 0, network: 'main' },
        { index: 1, network: 'main' },
        { index: 2, network: 'main' }
      ].map((p, i) => ({ ...p, ...(over[i] ?? {}) }))
    })

  test('name is kept trimmed and capped at 24 characters; empty or non-string names are dropped', () => {
    const p = parseProfilesState(three([{ name: '  Savings  ' }, { name: 'x'.repeat(40) }, { name: '   ' }])).profiles
    expect(p[0].name).toBe('Savings')
    expect(p[1].name).toBe('x'.repeat(24))
    expect(p[2]).not.toHaveProperty('name')
    expect(parseProfilesState(three([{ name: 7 }])).profiles[0]).not.toHaveProperty('name')
  })

  test('deleted survives only as true, and never on profile 0', () => {
    const p = parseProfilesState(three([{ deleted: true }, { deleted: true, identityKey: '02ab' }, { deleted: 'yes' }]))
    expect(p.profiles[0]).not.toHaveProperty('deleted')
    expect(p.profiles[1]).toEqual({ index: 1, network: 'main', identityKey: '02ab', deleted: true })
    expect(p.profiles[2]).not.toHaveProperty('deleted')
  })

  test('active never lands on a tombstone: it moves to the nearest live profile, lower index on a tie', () => {
    const raw = (active: number, dead: number[]) =>
      JSON.stringify({
        active,
        profiles: [0, 1, 2, 3].map(i => ({ index: i, network: 'main', ...(dead.includes(i) ? { deleted: true } : {}) }))
      })
    expect(parseProfilesState(raw(3, [3])).active).toBe(2)
    expect(parseProfilesState(raw(2, [2, 3])).active).toBe(1)
    expect(parseProfilesState(raw(2, [1, 2, 3])).active).toBe(0)
    // 1 is dead with 0 and 2 both one step away.
    expect(parseProfilesState(raw(1, [1])).active).toBe(0)
    // Already live: untouched.
    expect(parseProfilesState(raw(2, [1])).active).toBe(2)
    // Out of range still clamps to 0.
    expect(parseProfilesState(raw(9, [1])).active).toBe(0)
  })

  test('tombstones keep their slot, so the list stays dense', () => {
    const p = parseProfilesState(three([{}, { deleted: true }, {}]))
    expect(p.profiles.map(r => r.index)).toEqual([0, 1, 2])
  })
})

describe('normalizeProfileName', () => {
  test('trims, caps by character, and returns undefined for nothing', () => {
    expect(normalizeProfileName('  Work ')).toBe('Work')
    expect(normalizeProfileName('')).toBeUndefined()
    expect(normalizeProfileName('   ')).toBeUndefined()
    expect(normalizeProfileName(undefined)).toBeUndefined()
    expect(normalizeProfileName(12)).toBeUndefined()
    expect(normalizeProfileName('a'.repeat(30))).toHaveLength(24)
  })

  test('the cap counts characters, not UTF-16 halves, and does not leave a trailing space', () => {
    const cut = normalizeProfileName('😀'.repeat(30))!
    expect(Array.from(cut)).toHaveLength(24)
    expect(cut).toBe('😀'.repeat(24))
    expect(normalizeProfileName('a'.repeat(23) + ' bbb')).toBe('a'.repeat(23))
  })
})

describe('store', () => {
  test('append numbers sequentially and persists; load round-trips', async () => {
    const a = await appendProfile('test', { needsRestore: true })
    const b = await appendProfile()
    expect([a.index, b.index]).toEqual([1, 2])
    await setActiveProfile(1)
    __resetProfilesForTests()
    const loaded = await loadProfiles()
    expect(loaded.active).toBe(1)
    expect(loaded.profiles.map(p => p.network)).toEqual(['main', 'test', 'main'])
    expect(getActiveProfile()).toEqual({ index: 1, network: 'test', needsRestore: true })
  })

  test('setActiveProfile rejects an unknown index', async () => {
    await expect(setActiveProfile(1)).rejects.toThrow()
    expect(getActiveProfileIndex()).toBe(0)
  })

  test('updateProfile patches and clears needsRestore', async () => {
    await appendProfile('main', { needsRestore: true })
    await updateProfile(1, { identityKey: '02ab', needsRestore: false })
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'main', identityKey: '02ab' })
    await updateProfile(9, { network: 'test' })
    expect(getProfilesState().profiles).toHaveLength(2)
  })

  test('updateProfile sets, changes and clears the name; the equality check sees it', async () => {
    await appendProfile()
    const seen: number[] = []
    const unsub = subscribeProfiles(() => seen.push(1))
    await updateProfile(1, { name: '  Savings ' })
    expect(getProfilesState().profiles[1].name).toBe('Savings')
    await updateProfile(1, { name: 'Savings' }) // no change: no publish
    expect(seen).toHaveLength(1)
    await updateProfile(1, { name: 'Work' })
    expect(getProfilesState().profiles[1].name).toBe('Work')
    await updateProfile(1, { name: '   ' })
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'main' })
    expect(seen).toHaveLength(3)
    unsub()
    __resetProfilesForTests()
    expect((await loadProfiles()).profiles[1]).toEqual({ index: 1, network: 'main' })
  })

  test('a name round-trips through storage', async () => {
    await appendProfile()
    await updateProfile(1, { name: 'Savings' })
    __resetProfilesForTests()
    expect((await loadProfiles()).profiles[1].name).toBe('Savings')
  })

  test('a tombstone keeps its slot, its identity and its place in storage', async () => {
    await appendProfile()
    await appendProfile()
    await updateProfile(1, { identityKey: '02ab', name: 'Old' })
    await updateProfile(1, { deleted: true })
    expect(getProfilesState().profiles[1]).toEqual({
      index: 1,
      network: 'main',
      identityKey: '02ab',
      name: 'Old',
      deleted: true
    })
    __resetProfilesForTests()
    const loaded = await loadProfiles()
    expect(loaded.profiles.map(p => !!p.deleted)).toEqual([false, true, false])
    expect(loaded.profiles[1].identityKey).toBe('02ab')
  })

  test('an index is never reused: the next profile lands after the tombstones', async () => {
    await appendProfile()
    await updateProfile(1, { deleted: true })
    const next = await appendProfile()
    expect(next.index).toBe(2)
    expect(getProfilesState().profiles.map(p => p.index)).toEqual([0, 1, 2])
  })

  test('profile 0 cannot be tombstoned, and neither can the active profile', async () => {
    await appendProfile()
    await expect(updateProfile(0, { deleted: true })).rejects.toThrow()
    expect(getProfilesState().profiles[0]).not.toHaveProperty('deleted')
    await setActiveProfile(1)
    await expect(updateProfile(1, { deleted: true })).rejects.toThrow()
    expect(getProfilesState().profiles[1]).not.toHaveProperty('deleted')
    // Once the active profile has moved, the same patch is allowed.
    await setActiveProfile(0)
    await updateProfile(1, { deleted: true })
    expect(getProfilesState().profiles[1].deleted).toBe(true)
  })

  test('deleted can be cleared again', async () => {
    await appendProfile()
    await updateProfile(1, { deleted: true })
    await updateProfile(1, { deleted: undefined })
    expect(getProfilesState().profiles[1]).toEqual({ index: 1, network: 'main' })
  })

  test('setActiveProfile refuses a tombstone and leaves the active profile alone', async () => {
    await appendProfile()
    await appendProfile()
    await updateProfile(1, { deleted: true })
    await expect(setActiveProfile(1)).rejects.toThrow(/removed/i)
    expect(getActiveProfileIndex()).toBe(0)
    await setActiveProfile(2)
    expect(getActiveProfileIndex()).toBe(2)
  })

  test('getActiveProfile skips a tombstone even if the pointer somehow rests on one', async () => {
    await AsyncStorage.setItem(
      PROFILES_STORAGE_KEY,
      JSON.stringify({
        active: 1,
        profiles: [
          { index: 0, network: 'main' },
          { index: 1, network: 'test', deleted: true },
          { index: 2, network: 'main' }
        ]
      })
    )
    await loadProfiles()
    // parse already clamped it; the accessor and the index agree.
    expect(getActiveProfileIndex()).toBe(0)
    expect(getActiveProfile().index).toBe(0)
  })

  test('liveProfiles drops tombstones and keeps order', async () => {
    await appendProfile()
    await appendProfile()
    await appendProfile()
    await updateProfile(2, { deleted: true })
    expect(liveProfiles().map(p => p.index)).toEqual([0, 1, 3])
    expect(liveProfiles(getProfilesState()).map(p => p.index)).toEqual([0, 1, 3])
    expect(liveProfiles({ active: 0, profiles: [{ index: 0, network: 'main' }] })).toHaveLength(1)
  })

  test('listeners fire on change', async () => {
    const seen: number[] = []
    const unsub = subscribeProfiles(() => seen.push(getActiveProfileIndex()))
    await appendProfile()
    await setActiveProfile(1)
    unsub()
    expect(seen).toEqual([0, 1])
  })

  test('resetProfiles removes the stored record', async () => {
    await appendProfile()
    await setActiveProfile(1)
    await resetProfiles()
    expect(getProfilesState()).toEqual(defaultProfilesState())
    expect(await AsyncStorage.getItem(PROFILES_STORAGE_KEY)).toBeNull()
  })
})

describe('profileScopedKey', () => {
  test('profile 0 keeps the bare key; others suffix', async () => {
    expect(profileScopedKey('message_box_url')).toBe('message_box_url')
    expect(profileScopedKey('message_box_url', 2)).toBe('message_box_url__p2')
    await appendProfile()
    await setActiveProfile(1)
    expect(profileScopedKey('connections')).toBe('connections__p1')
    expect(PROFILE_KEY_SUFFIX_RE.test('connections__p1')).toBe(true)
    expect(PROFILE_KEY_SUFFIX_RE.test('connections')).toBe(false)
  })

  test('scoped keys are SecureStore-safe', () => {
    expect(profileScopedKey('arc_custom_api_token_main', 7)).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})
