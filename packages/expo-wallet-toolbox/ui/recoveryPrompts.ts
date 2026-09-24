/**
 * restorePrompts(t) — the ONE copy of both recovery dialogs recoverWallet
 * needs (`RestorePrompts` from core/recovery/recoverWallet.ts), built on
 * `showAlert`. Both the mnemonic screen and the scan-shares screen pass
 * `restorePrompts(t)` straight through to `recoverWallet`, so the copy for
 * a refused biometric or a failed backup replay exists exactly once.
 *
 * Dismissing an alert (Android back button, tapping outside) resolves
 * `showAlert` to something other than one of the declared button keys —
 * each prompt here maps that to the SAFER of its two choices, not the
 * literal "closest" one:
 *
 *  - biometricRefused: dismiss → 'cancel'. Nothing has been written yet at
 *    this point (a refused store attempt touches nothing — see
 *    restoreWallet.ts), so treating an ambiguous dismissal as "give up" costs
 *    the user nothing they had.
 *  - restoreFailed: dismiss → 'retry', never 'skip'. 'skip' proceeds WITHOUT
 *    replaying the encrypted backup, which can leave real coins unspendable
 *    (see recoverWallet.ts's docs) — an accidental tap-outside must never be
 *    read as "I accept that risk". 'retry' just returns the user to their
 *    input, which is always safe to default to.
 *  - confirmReplace: dismiss → 'keep', never 'replace'. 'replace' overwrites
 *    the device's only copy of an existing secret (see recoverWallet.ts's
 *    docs) — an accidental tap-outside must never be read as "yes, destroy
 *    my current wallet". 'keep' leaves the device exactly as it was.
 *
 * Does NOT decide the retry/skip POLICY (that's recoverWallet.ts, which
 * calls these and interprets the result) — this module only renders the two
 * dialogs and reports which button was pressed.
 */
import { showAlert } from './components/ui/AlertCard'
import type { RestorePrompts } from '../core/recovery/recoverWallet'

/** Loose structural type: whatever `useTranslation()`'s `t` looks like here. */
type TFunctionLike = (key: string) => string

export function restorePrompts(t: TFunctionLike): RestorePrompts {
  return {
    async biometricRefused() {
      const choice = await showAlert({
        title: t('scan_shares_biometric_title'),
        message: t('scan_shares_biometric_message'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'cancel' },
          { text: t('retry'), key: 'retry' }
        ]
      })
      return choice === 'retry' ? 'retry' : 'cancel'
    },

    async restoreFailed(error?: string) {
      const choice = await showAlert({
        title: t('restore_backup_failed_title'),
        message: t('restore_backup_failed_message') + (error ? '\n\n' + error : ''),
        buttons: [
          { text: t('restore_backup_retry'), key: 'retry' },
          { text: t('restore_backup_skip'), key: 'skip', style: 'destructive' }
        ]
      })
      return choice === 'skip' ? 'skip' : 'retry'
    },

    async confirmReplace() {
      const choice = await showAlert({
        title: t('recovery_replace_wallet_title'),
        message: t('recovery_replace_wallet_body'),
        buttons: [
          { text: t('cancel'), style: 'cancel', key: 'keep' },
          { text: t('recovery_replace_wallet_confirm'), style: 'destructive', key: 'replace' }
        ]
      })
      return choice === 'replace' ? 'replace' : 'keep'
    }
  }
}
