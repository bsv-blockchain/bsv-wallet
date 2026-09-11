/**
 * Which vault outputs are committed to the current key set — the source of the
 * vault screen's badges ("{{count}} deposits not yet open to {{nickname}}",
 * "{{count}} deposits still open to a removed key") and of the Remove-key
 * safety check (spec §3.4).
 *
 * Same invalidation contract as useVaultBalance: read on mount, on every
 * txStatusVersion bump and on refresh(); frozen while a transfer is in flight
 * (the spent outputs are gone and the re-vaulted remainder not yet visible, so
 * a read in that window is wrong), with one read when the window closes.
 *
 * `null` means "nothing readable yet": before the first read lands, and
 * whenever there is no built wallet. It is deliberately not an empty coverage
 * record — a caller deciding whether a key removal would orphan an output
 * must not mistake "could not look" for "looked and saw nothing".
 */
import { useCallback, useEffect, useState } from 'react'
import { useWallet, useVault, getVaultKeyCoverage, type VaultKeyCoverage, type VaultWallet } from '@bsv/expo-wallet-toolbox'

export function useVaultCoverage(): { coverage: VaultKeyCoverage | null; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const { state: vaultState } = useVault()
  const transferInFlight = vaultState.phase === 'preparing' || vaultState.phase === 'broadcasting'
  const [coverage, setCoverage] = useState<VaultKeyCoverage | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const refresh = useCallback(() => {
    setRefreshVersion(prev => prev + 1)
  }, [])

  useEffect(() => {
    const pm = managers?.permissionsManager
    if (!pm) {
      setCoverage(null)
      return
    }
    if (transferInFlight) return
    let cancelled = false
    getVaultKeyCoverage(pm as unknown as VaultWallet, adminOriginator)
      .then(next => {
        if (!cancelled) setCoverage(next)
      })
      .catch(() => {
        // Leave the last known coverage in place on a transient failure.
      })
    return () => {
      cancelled = true
    }
  }, [managers?.permissionsManager, adminOriginator, txStatusVersion, transferInFlight, refreshVersion])

  return { coverage, refresh }
}
