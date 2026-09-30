/**
 * Has this device already seen the push notification advisory?
 *
 * Sharing a remote link to receive payments (via "Share remote link" on
 * "Get paid") triggers the one-time MessageBox push notification advisory,
 * which explains that push notifications will be sent only while the app is
 * open. This flag is a device-level UX preference, not a security record, so
 * unlike backupAttestation it is not scoped per wallet identity — there is no
 * per-identity harm in a shared device remembering "already explained this."
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'push_advisory_shown_v1'

export const pushAdvisory = {
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
