/**
 * XQ-005 (COV-074, Android half) — locks 79fc84a3 ("turn off OS auto-backup
 * of the app container") against regression. Before that commit, Android's
 * Auto-Backup-for-Apps default (allowBackup unset -> true) would copy the
 * plaintext SQLite wallet database — vault-output salts included — off-device
 * with no user action. Nothing asserted this in a test until now.
 */
import appJson from '../app.json'

describe('app.json android backup config', () => {
  it('XQ-005: keeps allowBackup disabled so Android never auto-backs-up the plaintext wallet database', () => {
    expect(appJson.expo.android.allowBackup).toBe(false)
  })
})
