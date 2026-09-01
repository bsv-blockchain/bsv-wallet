/**
 * Has this device actually put a backup on the server?
 *
 * Read from the push cursor rather than by asking the server: the cursor is
 * written only after chunks are appended, so a non-zero `seq` is this device's
 * own record of a completed upload. It also answers offline, which matters —
 * "we could not reach the server" is not the same as "you have no backup", and
 * the troubleshooting list must not conflate them.
 *
 * Scanning the key prefix avoids needing the primary key (the pseudonym is
 * derived from it) up in the UI, where it has no business being.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { isBackupPushEnabled } from './preference'

const CURSOR_PREFIX = 'backupCursor-'

export type BackupUploadState = {
  /** The user has not opted out. */
  enabled: boolean
  /** At least one chunk has been appended for some generation on this device. */
  uploaded: boolean
}

export async function getBackupUploadState(): Promise<BackupUploadState> {
  const enabled = await isBackupPushEnabled()
  let uploaded = false
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(CURSOR_PREFIX))
    if (keys.length > 0) {
      const entries = await AsyncStorage.multiGet(keys)
      uploaded = entries.some(([, raw]) => {
        if (!raw) return false
        try {
          const parsed = JSON.parse(raw) as { seq?: unknown }
          return typeof parsed.seq === 'number' && parsed.seq > 0
        } catch {
          return false
        }
      })
    }
  } catch {
    // An unreadable store is not evidence of a backup.
  }
  return { enabled, uploaded }
}
