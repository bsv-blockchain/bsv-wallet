/**
 * Has THIS wallet actually put a backup on the server?
 *
 * Read from the push cursor rather than by asking the server: the cursor is
 * written only after chunks are appended, so a non-zero `seq` is this device's
 * own record of a completed upload. It also answers offline, which matters —
 * "we could not reach the server" is not the same as "you have no backup", and
 * the troubleshooting list must not conflate them.
 *
 * Scoped to `chain`+`pseudonym` (the caller's own identity), not merely the bare
 * `backupCursor-` prefix: `cursorKey`'s deviceId component never changes across a
 * logout/re-import on the same install (see deviceId.ts), so an unscoped scan can read a
 * DIFFERENT, departed wallet's leftover cursor and report a brand-new wallet as backed up
 * before it has ever pushed anything (XR-009). The pseudonym is derived from the primary
 * key but is not itself secret — it is exactly what the backup server sees as this
 * wallet's account — so passing it here still keeps the primary key itself out of the UI.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cursorKeyPrefix, type BackupChain } from './constants'
import { isBackupPushEnabled } from './preference'

export type BackupUploadState = {
  /** The user has not opted out. */
  enabled: boolean
  /** At least one chunk has been appended for some generation, under this identity. */
  uploaded: boolean
}

export async function getBackupUploadState(chain: BackupChain, pseudonym: string): Promise<BackupUploadState> {
  const enabled = await isBackupPushEnabled()
  let uploaded = false
  try {
    const prefix = cursorKeyPrefix(chain, pseudonym)
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(prefix))
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
