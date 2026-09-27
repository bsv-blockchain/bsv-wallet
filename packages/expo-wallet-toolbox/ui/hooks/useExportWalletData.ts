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
 * authenticated-encryption step. Encrypting it needs a product decision on how
 * the importing device gets the key back (importDatabases.ts has no decrypt
 * step either). The confirmation alert that used to precede the share sheet
 * was removed by product decision: the tap goes straight to the native save
 * prompt.
 */
import { useCallback, useRef, useState } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { exportAllWalletDatabases } from '../exportDatabases'

export function useExportWalletData(): { exportData: () => Promise<void>; exporting: boolean } {
  const { storage } = useWallet()
  const [exporting, setExporting] = useState(false)
  // A ref, not the state: two taps in the same tick both see `exporting ===
  // false` in their closure, and the second must still be refused.
  const inFlightRef = useRef(false)

  const exportData = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setExporting(true)
    try {
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
