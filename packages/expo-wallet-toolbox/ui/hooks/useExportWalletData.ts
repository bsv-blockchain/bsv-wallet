/**
 * Export the wallet database through the OS share sheet — the action behind
 * Settings › "Export Wallet Data" and the Vault screen's row of the same name
 * (spec §3.4: the vault screen is where the user is thinking about recovery,
 * and encrypted export preserves the recovery metadata/history mirrored by
 * each output. The salt in v6 custom instructions is rederived through the
 * wallet HMAC and used to rebuild the lock's salted commitments).
 *
 * Lifted from WalletConfigScreen.handleExportData so both screens share one
 * implementation: one export at a time, `exporting` for the spinner, failures
 * logged rather than surfaced (a dismissed share sheet is not an error).
 *
 * XR-086: exportAllWalletDatabases() writes the raw, unencrypted SQLite image
 * straight to the OS share sheet — identity keys, certificate fields,
 * transaction/derivation metadata and contacts, with no passphrase or
 * authenticated-encryption step. Wrapping it in one would need a product
 * decision this hook cannot make alone (how the *importing* device gets the
 * key/passphrase back — see importDatabases.ts, which has no decrypt step
 * either); that is recorded as a design delta on XR-086, not silently
 * skipped. What actually ships here is the part that needs no such decision:
 * an explicit warning naming what the file contains and that it is not
 * encrypted, with a real chance to back out, shared by both call sites since
 * they both go through this one hook.
 */
import { useCallback, useRef, useState } from 'react'
import { i18n, useWallet } from '@bsv/expo-wallet-toolbox'
import { exportAllWalletDatabases } from '../exportDatabases'
import { showAlert } from '../components/ui/AlertCard'

export function useExportWalletData(): { exportData: () => Promise<void>; exporting: boolean } {
  const { storage } = useWallet()
  const [exporting, setExporting] = useState(false)
  // A ref, not the state: two taps in the same tick both see `exporting ===
  // false` in their closure, and the second must still be refused.
  const inFlightRef = useRef(false)

  const exportData = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const choice = await showAlert({
        title: i18n.t('export_unencrypted_title'),
        message: i18n.t('export_unencrypted_message'),
        buttons: [
          { text: i18n.t('cancel'), style: 'cancel', key: 'cancel' },
          { text: i18n.t('export_wallet_data'), style: 'destructive', key: 'export' }
        ]
      })
      if (choice !== 'export') return
      // The spinner means "exporting", not "waiting for you to answer".
      setExporting(true)
      await exportAllWalletDatabases(storage)
    } catch (e) {
      console.warn('[exportWalletData] Export failed:', e)
    } finally {
      inFlightRef.current = false
      setExporting(false)
    }
  }, [storage])

  return { exportData, exporting }
}
