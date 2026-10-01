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
  loadProfiles,
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
    const raw = JSON.stringify({ active: 5, profiles: [{ index: 0, network: 'main' }, { index: 1, network: 'test' }] })
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
