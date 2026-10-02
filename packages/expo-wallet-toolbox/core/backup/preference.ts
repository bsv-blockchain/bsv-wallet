/**
 * The user's opt-out for pushing to the backup server.
 *
 * ON by default, and every ambiguous case resolves to ON: a missing key, an unreadable
 * store, an unrecognised value. Opting out is the only thing that turns pushing off, and it
 * writes 'false' explicitly — absence can never mean "off", because a wallet that quietly
 * stopped backing up (and only found out when it needed a restore) is exactly the outcome
 * the backup log exists to prevent.
 *
 * The opt-out stops pushing only. Restoring on a new device still works: a log already on
 * the server stays readable, and `restoreOnImport` never consults this.
 *
 * Per profile: each profile pushes to its own server account, so the flag goes through
 * `profileScopedKey` (profile 0 keeps the bare key, profile n appends `__p<n>`). Opting one
 * profile out, or erasing its server copy, must never silence another profile's backup.
 * Callers that hold a specific profile's key pass its index; anything else means "what the
 * user is looking at" and takes the active profile.
 *
 * Not stored in wallet settings: those live in the wallet database, which is itself what
 * gets backed up, and the flag has to be readable by a push pass that runs before/without
 * the settings manager.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { profileScopedKey } from '../profiles/profileStore'

/** Profile 0's key; other profiles append `__p<n>` (see `profileScopedKey`). */
export const BACKUP_PUSH_ENABLED_KEY = 'backupPushEnabled'

/** True unless the user has explicitly opted out. Never throws. */
export async function isBackupPushEnabled (profileIndex?: number): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(profileScopedKey(BACKUP_PUSH_ENABLED_KEY, profileIndex))) !== 'false'
  } catch {
    // Fail towards backing up. The alternative silently abandons the user's history.
    return true
  }
}

export async function setBackupPushEnabled (enabled: boolean, profileIndex?: number): Promise<void> {
  await AsyncStorage.setItem(profileScopedKey(BACKUP_PUSH_ENABLED_KEY, profileIndex), enabled ? 'true' : 'false')
}
