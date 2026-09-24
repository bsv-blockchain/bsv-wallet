/**
 * restorePrompts(t) — the one copy of both recovery dialogs, built on
 * showAlert. recoverWallet reads only 'retry'|'cancel' and 'retry'|'skip'
 * from these, so a dismissed/back-button alert must resolve to the SAFE
 * choice for each: cancel (nothing was lost) and retry (dismissing must
 * never be read as "abandon my history").
 */
const mockShowAlert = jest.fn()

jest.mock('../../ui/components/ui/AlertCard', () => ({
  showAlert: (...args: [unknown]) => mockShowAlert(...args)
}))

import { restorePrompts } from '../../ui/recoveryPrompts'

const t = (key: string) => `t:${key}`

describe('restorePrompts', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('biometricRefused', () => {
    test('calls showAlert with the biometric copy and cancel/retry buttons', async () => {
      mockShowAlert.mockResolvedValueOnce('retry')
      await restorePrompts(t).biometricRefused()

      expect(mockShowAlert).toHaveBeenCalledWith({
        title: t('scan_shares_biometric_title'),
        message: t('scan_shares_biometric_message'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'cancel' },
          { text: t('retry'), key: 'retry' }
        ]
      })
    })

    test("resolves 'retry' when showAlert resolves 'retry'", async () => {
      mockShowAlert.mockResolvedValueOnce('retry')
      await expect(restorePrompts(t).biometricRefused()).resolves.toBe('retry')
    })

    test("resolves 'cancel' when showAlert resolves 'cancel'", async () => {
      mockShowAlert.mockResolvedValueOnce('cancel')
      await expect(restorePrompts(t).biometricRefused()).resolves.toBe('cancel')
    })

    test.each(['dismiss', undefined, ''])("resolves 'cancel' for anything else (%s)", async other => {
      mockShowAlert.mockResolvedValueOnce(other)
      await expect(restorePrompts(t).biometricRefused()).resolves.toBe('cancel')
    })
  })

  describe('restoreFailed', () => {
    test('message includes the error, suffixed after two newlines', async () => {
      mockShowAlert.mockResolvedValueOnce('retry')
      await restorePrompts(t).restoreFailed('boom')

      expect(mockShowAlert).toHaveBeenCalledWith({
        title: t('restore_backup_failed_title'),
        message: t('restore_backup_failed_message') + '\n\nboom',
        buttons: [
          { text: t('restore_backup_retry'), key: 'retry' },
          { text: t('restore_backup_skip'), key: 'skip', style: 'destructive' }
        ]
      })
    })

    test('no suffix when error is undefined', async () => {
      mockShowAlert.mockResolvedValueOnce('retry')
      await restorePrompts(t).restoreFailed(undefined)

      expect(mockShowAlert).toHaveBeenCalledWith(
        expect.objectContaining({ message: t('restore_backup_failed_message') })
      )
    })

    test("resolves 'skip' only when showAlert resolves 'skip'", async () => {
      mockShowAlert.mockResolvedValueOnce('skip')
      await expect(restorePrompts(t).restoreFailed('boom')).resolves.toBe('skip')
    })

    test("resolves 'retry' when showAlert resolves 'retry'", async () => {
      mockShowAlert.mockResolvedValueOnce('retry')
      await expect(restorePrompts(t).restoreFailed('boom')).resolves.toBe('retry')
    })

    test.each(['cancel', undefined])("resolves 'retry' for %s (Android back / dismiss)", async other => {
      mockShowAlert.mockResolvedValueOnce(other)
      await expect(restorePrompts(t).restoreFailed('boom')).resolves.toBe('retry')
    })
  })

  describe('restoreUnverified', () => {
    test('calls showAlert with the unverified-backup copy and a single dismiss button', async () => {
      mockShowAlert.mockResolvedValueOnce('dismiss')
      await restorePrompts(t).restoreUnverified()

      expect(mockShowAlert).toHaveBeenCalledWith({
        title: t('restore_backup_unverified_title'),
        message: t('restore_backup_unverified_body'),
        buttons: [{ text: t('dismiss'), key: 'dismiss' }]
      })
    })

    test('resolves once showAlert resolves, regardless of what it resolves to', async () => {
      mockShowAlert.mockResolvedValueOnce('dismiss')
      await expect(restorePrompts(t).restoreUnverified()).resolves.toBeUndefined()
    })
  })

  describe('confirmReplace', () => {
    test('calls showAlert with the replace-wallet copy, destructive confirm button', async () => {
      mockShowAlert.mockResolvedValueOnce('replace')
      await restorePrompts(t).confirmReplace()

      expect(mockShowAlert).toHaveBeenCalledWith({
        title: t('recovery_replace_wallet_title'),
        message: t('recovery_replace_wallet_body'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'keep' },
          { text: t('recovery_replace_wallet_confirm'), style: 'destructive', key: 'replace' }
        ]
      })
    })

    test("resolves 'replace' when showAlert resolves 'replace'", async () => {
      mockShowAlert.mockResolvedValueOnce('replace')
      await expect(restorePrompts(t).confirmReplace()).resolves.toBe('replace')
    })

    test.each(['keep', 'cancel', undefined, ''])("resolves 'keep' for anything else (%s)", async other => {
      mockShowAlert.mockResolvedValueOnce(other)
      await expect(restorePrompts(t).confirmReplace()).resolves.toBe('keep')
    })
  })
})
