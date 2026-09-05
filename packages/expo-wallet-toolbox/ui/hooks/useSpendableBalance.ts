/**
 * Spendable wallet balance for the send surfaces — the same figure the wallet
 * screen shows, read the same two ways: the cached figure immediately (so the
 * line never opens empty), then straight to our own SQLite rather than through
 * WalletStorageManager's FIFO reader lock (see storage/methods/walletBalanceSql
 * and the storage-lock notes in app/index.tsx). The wallet's own listOutputs
 * path stays as the fallback for the window before storage and the user id are
 * known. Refreshes on txStatusVersion bumps so a completed send updates it.
 */
import { useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { useWallet, readWalletBalance } from '@bsv/expo-wallet-toolbox'
import { storageMatchesNetwork } from '../../core/net/chainMatch'

export function useSpendableBalance(): number | null {
  const { managers, adminOriginator, selectedNetwork, storage, txStatusVersion, walletUserId } = useWallet()
  const cacheKey = `cached_wallet_balance_${selectedNetwork}`
  const [balance, setBalance] = useState<{ key: string; value: number } | null>(null)
  // Serialize reads, retaining the latest invalidation while one is in flight.
  // A plain busy flag loses it: the old effect is cancelled, while the new one
  // sees the flag and returns, so neither can update the displayed figure.
  const inFlightRef = useRef(false)
  const pendingRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const cached = await AsyncStorage.getItem(cacheKey)
        const value = cached == null ? NaN : Number(cached)
        if (!cancelled && Number.isFinite(value)) {
          setBalance(prev => prev?.key === cacheKey ? prev : { key: cacheKey, value })
        }
      } catch {
        // A broken cache must not prevent the live read below.
      }
      if (cancelled) return
      // During a network rebuild the previous chain's storage can still be
      // mounted. Never read it or write its figure into the new chain's cache.
      if (storage && !storageMatchesNetwork(storage, selectedNetwork)) return
      try {
        let total: number | null = null
        if (storage && walletUserId != null) {
          total = await readWalletBalance(storage, walletUserId)
        }
        if (cancelled) return
        if (total == null) {
          const pm = managers?.permissionsManager
          if (!pm) return
          const { totalOutputs } = await pm.listOutputs({ basket: sdk.specOpWalletBalance }, adminOriginator)
          total = totalOutputs ?? 0
        }
        if (cancelled) return
        setBalance(prev => prev?.key === cacheKey && prev.value === total ? prev : { key: cacheKey, value: total })
        await AsyncStorage.setItem(cacheKey, String(total))
      } catch {
        // Keep the last known figure: a failed read is not "zero satoshis".
      }
    }

    pendingRef.current = refresh
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
      if (pendingRef.current === refresh) pendingRef.current = null
    }
  }, [cacheKey, selectedNetwork, storage, walletUserId, managers?.permissionsManager, adminOriginator, txStatusVersion])

  // Hide the old chain's figure immediately, before the new effect reads cache.
  return balance?.key === cacheKey ? balance.value : null
}
