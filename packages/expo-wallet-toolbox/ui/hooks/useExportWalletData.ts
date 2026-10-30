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
 * shown as an error toast (a dismissed share sheet resolves, so is not one).
 *
 * XR-086: the export is encrypted by default — `wallet.encrypt` (counterparty
 * `self`, through the permissions manager as the admin originator, so no
 * prompt) wraps a per-file AES key, so only this wallet can import it again.
 * `exportData({ encrypt: false })` still writes the raw SQLite image, for
 * development builds that want to open it in a SQLite browser. The
 * confirmation alert that used to precede the share sheet was removed by
 * product decision: the tap goes straight to the native save prompt.
 */
import { useCallback, useRef, useState } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { exportAllWalletDatabases } from '../exportDatabases'
import { showToast } from '../components/ui/Toast'

export function useExportWalletData(): {
  exportData: (opts?: { encrypt?: boolean }) => Promise<void>
  exporting: boolean
} {
  const { storage, managers, adminOriginator } = useWallet()
  const [exporting, setExporting] = useState(false)
  // A ref, not the state: two taps in the same tick both see `exporting ===
  // false` in their closure, and the second must still be refused.
  const inFlightRef = useRef(false)

  const exportData = useCallback(
    async ({ encrypt = true }: { encrypt?: boolean } = {}) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setExporting(true)
      try {
        await exportAllWalletDatabases(
          storage,
          encrypt ? { encrypt, wallet: managers.permissionsManager, originator: adminOriginator } : {}
        )
      } catch (e) {
        // A dismissed share sheet resolves rather than throws, so anything
        // landing here is a real failure (no crypto backend, no wallet yet,
        // the snapshot refused) the user would otherwise never hear about.
        console.warn('[exportWalletData] Export failed:', e)
        showToast(e instanceof Error ? e.message : String(e), { type: 'error' })
      } finally {
        inFlightRef.current = false
        setExporting(false)
      }
    },
    [storage, managers.permissionsManager, adminOriginator]
  )

  return { exportData, exporting }
}
