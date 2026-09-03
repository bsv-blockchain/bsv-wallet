/**
 * Has this device already seen the nearby-payments advisory?
 *
 * Nearby payments trigger OS-level prompts (iOS Local Network access, and on
 * Android Bluetooth/nearby-Wi-Fi permissions) that, without warning, read as
 * the app trying to profile the user. NearbyAdvisoryModal explains those
 * prompts up front, once, the first time the user opens a nearby pay/get-paid
 * cell. This flag is a device-level UX preference, not a security record, so
 * unlike backupAttestation it is not scoped per wallet identity — there is no
 * per-identity harm in a shared device remembering "already explained this."
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'nearby_advisory_shown_v1'

export const nearbyAdvisory = {
  async get(): Promise<boolean> {
    try {
      return (await AsyncStorage.getItem(KEY)) === 'true'
    } catch {
      return false
    }
  },

  async set(): Promise<void> {
    try {
      await AsyncStorage.setItem(KEY, 'true')
    } catch {
      // Advisory only — a failed write just means the modal shows again next time.
    }
  }
}
