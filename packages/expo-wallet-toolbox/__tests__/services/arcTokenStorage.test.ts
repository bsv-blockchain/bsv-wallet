/**
 * XR-106: the ARC API token is a live Bearer credential (used as
 * `Authorization: Bearer <token>` by arcadeBroadcastProvider.ts) but was
 * persisted verbatim in plaintext AsyncStorage, which is not encrypted at
 * rest and is readable from an unencrypted device backup or a rooted /
 * jailbroken device. It must instead live in the platform SecureStore
 * (device keychain / keystore), with any value a pre-fix build already left
 * behind in plaintext AsyncStorage migrated across and wiped.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { fake as secureStoreFake } from '../__mocks__/secureStoreFake'
import { arcApiTokenStorageKey } from '../../core/constants'
import { getArcApiToken, setArcApiToken } from '../../core/services/arcTokenStorage'

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

const NETWORK = 'main'
const KEY = arcApiTokenStorageKey(NETWORK)

beforeEach(async () => {
  secureStoreFake.__reset()
  await AsyncStorage.clear()
})

describe('XR-106: ARC API token storage moves off plaintext AsyncStorage', () => {
  it('setArcApiToken writes the token to SecureStore, not AsyncStorage', async () => {
    await setArcApiToken(NETWORK, 'secret-token-A')

    expect(await AsyncStorage.getItem(KEY)).toBeNull()
    expect(secureStoreFake.__get(KEY)).toBe('secret-token-A')
  })

  it('getArcApiToken reads the token back from SecureStore', async () => {
    await setArcApiToken(NETWORK, 'secret-token-A')

    expect(await getArcApiToken(NETWORK)).toBe('secret-token-A')
  })

  it('setArcApiToken(null) deletes the SecureStore entry', async () => {
    await setArcApiToken(NETWORK, 'secret-token-A')
    await setArcApiToken(NETWORK, null)

    expect(await getArcApiToken(NETWORK)).toBeNull()
    expect(secureStoreFake.__has(KEY)).toBe(false)
  })

  it('migrates a legacy plaintext AsyncStorage value into SecureStore and erases the plaintext copy', async () => {
    // Simulate what a pre-fix build left behind.
    await AsyncStorage.setItem(KEY, 'legacy-plaintext-token')

    const token = await getArcApiToken(NETWORK)

    expect(token).toBe('legacy-plaintext-token')
    expect(await AsyncStorage.getItem(KEY)).toBeNull()
    expect(secureStoreFake.__get(KEY)).toBe('legacy-plaintext-token')
  })

  it('does not let a stale plaintext AsyncStorage value override a newer SecureStore value', async () => {
    await setArcApiToken(NETWORK, 'secure-token')
    // Something (should never happen post-fix, but modeled defensively) left
    // an older plaintext copy sitting in AsyncStorage under the same key.
    await AsyncStorage.setItem(KEY, 'stale-plaintext-token')

    const token = await getArcApiToken(NETWORK)

    expect(token).toBe('secure-token')
    expect(await AsyncStorage.getItem(KEY)).toBeNull()
  })
})
