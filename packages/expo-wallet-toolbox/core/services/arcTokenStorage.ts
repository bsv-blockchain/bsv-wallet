import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { arcApiTokenStorageKey } from '../constants'

/**
 * XR-106: the custom ARC API token a holder can configure in
 * WalletConfigScreen is a live credential — createServiceOptions puts it on
 * `arcConfig.apiKey` and arcadeBroadcastProvider.ts sends it verbatim as
 * `Authorization: Bearer <token>` on every broadcast to that endpoint — but it
 * was persisted in plaintext AsyncStorage, which carries no at-rest
 * encryption and is readable from an unencrypted device backup or a rooted /
 * jailbroken device.
 *
 * This moves it into the platform SecureStore (iOS Keychain / Android
 * Keystore), the same plain (no biometric gate, no keychainService override)
 * pattern WalletConnectionContext already uses for its paired-session
 * sequence counters — this is a non-Vault, non-signing service-config value,
 * so it does not need the KEK-wrapped envelope scheme that protects wallet
 * root secrets.
 *
 * Both functions also fold in a one-time migration of whatever a pre-fix
 * build already left behind in plaintext AsyncStorage under the same key, so
 * an existing configured token keeps working and is wiped from the
 * unencrypted store on the very next read or write rather than sitting there
 * indefinitely.
 */
export async function getArcApiToken(network: string): Promise<string | null> {
  const key = arcApiTokenStorageKey(network)
  const legacy = await AsyncStorage.getItem(key)
  const secure = await SecureStore.getItemAsync(key)
  if (legacy === null) return secure
  // A plaintext copy survived from before this fix (or from some other bug) —
  // erase it unconditionally. A value already in SecureStore is authoritative
  // over a stale plaintext one; only promote the legacy value when SecureStore
  // has nothing yet.
  await AsyncStorage.removeItem(key)
  if (secure !== null) return secure
  await SecureStore.setItemAsync(key, legacy)
  return legacy
}

export async function setArcApiToken(network: string, token: string | null): Promise<void> {
  const key = arcApiTokenStorageKey(network)
  // Always clear any plaintext copy, whether or not one exists, so this
  // function alone is enough to close out a legacy value.
  await AsyncStorage.removeItem(key)
  if (token) {
    await SecureStore.setItemAsync(key, token)
  } else {
    await SecureStore.deleteItemAsync(key)
  }
}
