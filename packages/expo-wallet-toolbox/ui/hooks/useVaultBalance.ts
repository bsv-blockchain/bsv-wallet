/**
 * Vault balance — the sum of outputs in the `admin vault` basket. Separate from
 * the main wallet balance (which is managed-change-only and deliberately
 * excludes vault funds). Refreshes on txStatusVersion bumps and on demand
 * after a transfer.
 *
 * FROZEN while a transfer is mid-flight (ceremony phase 'preparing' /
 * 'broadcasting'): in that window the spent vault UTXO is gone and its change
 * is still unsent, so a fetch reads 0 — a partial withdrawal would flash
 * "balance: 0" mid-operation. The last known figure stays up; the busy→idle
 * transition refetches, covering any txStatusVersion bumps the freeze
 * swallowed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet, useVault, getVaultBalance, type VaultWallet } from '@bsv/expo-wallet-toolbox'

export function useVaultBalance(): { balance: number | null; loading: boolean; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const { state: vaultState } = useVault()
  // The zero-read window: both transfer paths note 'preparing' BEFORE their
  // createAction and stay busy until the broadcast settles (transfers.ts).
  const transferInFlight = vaultState.phase === 'preparing' || vaultState.phase === 'broadcasting'
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  // Read the latest figure without making balance changes trigger another read.
  const balanceRef = useRef<number | null>(null)
  balanceRef.current = balance
  const inFlightRef = useRef(false)
  const pendingRef = useRef<(() => Promise<void>) | null>(null)

  const refresh = useCallback(() => {
    setRefreshVersion(prev => prev + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const pm = managers?.permissionsManager
    if (transferInFlight || !pm) {
      setLoading(false)
      return
    }

    const read = async () => {
      if (balanceRef.current === null) setLoading(true)
      try {
        const next = await getVaultBalance(pm as unknown as VaultWallet, adminOriginator)
        if (!cancelled) setBalance(next)
      } catch {
        // Leave the last known balance in place on a transient failure.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    // Retain only the latest invalidation while a read is in flight. Cleanup
    // also discards results from reads that started before the transfer freeze.
    pendingRef.current = read
    if (!inFlightRef.current) {
      inFlightRef.current = true
      void (async () => {
        try {
          while (pendingRef.current) {
            const next = pendingRef.current
            pendingRef.current = null
            await next()
          }
        } finally {
          inFlightRef.current = false
        }
      })()
    }

    return () => {
      cancelled = true
      if (pendingRef.current === read) pendingRef.current = null
    }
  }, [managers?.permissionsManager, adminOriginator, txStatusVersion, transferInFlight, refreshVersion])

  return { balance, loading, refresh }
}
