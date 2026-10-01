/**
 * Per-profile device state: everything that belongs to one wallet profile lands
 * on that profile's keys, and switching back reads the other profile's own.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { fake as secureStoreFake } from '../__mocks__/secureStoreFake'
import { arcApiTokenStorageKey } from '../../core/constants'
import {
  clearArcApiTokensForProfile,
  getArcApiToken,
  setArcApiToken
} from '../../core/services/arcTokenStorage'
import { getUserAvatarIcon, loadUserAvatarIcon, setUserAvatarIcon } from '../../core/userAvatar'
import connectionStore from '../../core/stores/ConnectionStore'
import { markSeen, readSeen, SEEN_ASSETS_KEY } from '../../ui/tokenSeen'
import { __resetProfilesForTests, appendProfile, setActiveProfile } from '../../core/profiles/profileStore'

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(async () => {
  __resetProfilesForTests()
  secureStoreFake.__reset()
  await AsyncStorage.clear()
  await appendProfile()
})

test('ARC token is per profile', async () => {
  await setArcApiToken('main', 'token-p0')
  await setActiveProfile(1)
  expect(await getArcApiToken('main')).toBeNull()
  await setArcApiToken('main', 'token-p1')
  expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p1`)).toBe('token-p1')
  await setActiveProfile(0)
  expect(await getArcApiToken('main')).toBe('token-p0')

  await clearArcApiTokensForProfile(1)
  expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p1`)).toBeUndefined()
  expect(await getArcApiToken('main')).toBe('token-p0')
})

test('avatar is per profile, and a profile without one gets the default', async () => {
  setUserAvatarIcon({ family: 'ionicons', name: 'rocket' })
  await flush()
  await setActiveProfile(1)
  await loadUserAvatarIcon()
  expect(getUserAvatarIcon()).toBeNull()
  setUserAvatarIcon({ family: 'ionicons', name: 'leaf' })
  await flush()
  expect(await AsyncStorage.getItem('wallet_user_avatar_icon__p1')).toBe('ionicons/leaf')
  await setActiveProfile(0)
  await loadUserAvatarIcon()
  expect(getUserAvatarIcon()).toEqual({ family: 'ionicons', name: 'rocket' })
})

test('paired connections are per profile', async () => {
  await connectionStore.reload()
  connectionStore.add({ sessionId: 's0', status: 'connected' } as never)
  await flush()
  await setActiveProfile(1)
  await connectionStore.reload()
  expect(connectionStore.connections).toEqual([])
  await setActiveProfile(0)
  await connectionStore.reload()
  expect(connectionStore.connections.map(c => c.sessionId)).toEqual(['s0'])
})

test('seen-token markers are per profile', async () => {
  await markSeen(SEEN_ASSETS_KEY, 'asset-a')
  await setActiveProfile(1)
  expect(await readSeen(SEEN_ASSETS_KEY)).toEqual([])
  await markSeen(SEEN_ASSETS_KEY, 'asset-b')
  expect(await AsyncStorage.getItem(`${SEEN_ASSETS_KEY}__p1`)).toBe(JSON.stringify(['asset-b']))
  expect(await readSeen(SEEN_ASSETS_KEY, 0)).toEqual(['asset-a'])
})
