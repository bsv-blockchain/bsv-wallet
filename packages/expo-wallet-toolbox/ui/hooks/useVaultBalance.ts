/**
 * Vault balance — the sum of outputs in the `admin vault` basket. Separate from
 * the main wallet balance (which is managed-change-only and deliberately
 * excludes vault funds). Refreshes on txStatusVersion bumps and on demand
 * after a transfer.
 *
 * The figure lives in a module-level store rather than in each caller's state,
 * so every mounted reader shows the same number and a screen that mounts after
 * a read starts from it instead of from "unknown" — which both screens render
 * as `balance ?? 0`, making a funded vault look emptied. The store is keyed to
 * the permissions manager it was read through, so a wallet switch reads as
 * unknown rather than showing the previous wallet's vault.
 *
 * FROZEN while a transfer is mid-flight (ceremony phase 'preparing' /
 * 'broadcasting'): in that window the spent vault UTXO is gone and its change
 * is still unsent, so a fetch reads 0 — a partial withdrawal would flash
 * "balance: 0" mid-operation. The last known figure stays up; the busy→idle
 * transition refetches, covering any txStatusVersion bumps the freeze
 * swallowed.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useWallet, useVault, getVaultBalance, type VaultWallet } from '@bsv/expo-wallet-toolbox'

/**
 * How long the store keeps showing a transfer's expected figure while reads
 * still disagree with it. The freeze above covers the ceremony itself; this
 * covers the tail AFTER it, where the spent input has already left the listing
 * but the output the transfer created has not arrived yet — a read there is
 * successful and wrong, and committing it is exactly the zero we are avoiding.
 * Ten tries at 300 ms is the same budget the transfer screen used to spend
 * blocking the user on this screen; it now runs in the background instead.
 */
const SETTLE_ATTEMPTS = 10
const SETTLE_DELAY_MS = 300

/** The manager `cached` was read through; a different one reads as unknown. */
let cacheKey: unknown = null
let cached: number | null = null
/** The figure a transfer says is coming, and how many disagreeing reads may
 * still be discarded before the store believes them instead. */
let expected: number | null = null
let attemptsLeft = 0
let settleTimer: ReturnType<typeof setTimeout> | undefined
/** Bumped to ask every mounted reader to fetch again. */
let version = 0

const readers = new Set<() => void>()
const notify = (): void => {
  for (const onStoreChange of [...readers]) onStoreChange()
}
const subscribe = (onStoreChange: () => void): (() => void) => {
  readers.add(onStoreChange)
  return () => {
    readers.delete(onStoreChange)
  }
}

const bumpVersion = (): void => {
  version++
  notify()
}

const clearSettle = (): void => {
  expected = null
  attemptsLeft = 0
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer)
    settleTimer = undefined
  }
}

/**
 * Publish the figure a just-completed transfer produces, before any read can
 * confirm it. Callers own the arithmetic: they know what they moved.
 *
 * It publishes under whichever manager last read a balance, which is always
 * the current one by the time a transfer can run — `canRun` requires a
 * non-null balance, so a successful read has already happened.
 */
export function expectVaultBalance(satoshis: number): void {
  clearSettle()
  cached = satoshis
  expected = satoshis
  attemptsLeft = SETTLE_ATTEMPTS
  notify()
}

/** Commit a successful read, unless it still disagrees with what a transfer
 * said was coming and the budget for waiting it out is not yet spent. */
function commitRead(key: unknown, satoshis: number): void {
  if (key !== cacheKey) clearSettle()
  if (expected !== null && satoshis !== expected && attemptsLeft > 0) {
    attemptsLeft--
    if (settleTimer === undefined) {
      settleTimer = setTimeout(() => {
        settleTimer = undefined
        bumpVersion()
      }, SETTLE_DELAY_MS)
    }
    return
  }
  clearSettle()
  cacheKey = key
  cached = satoshis
  notify()
}

export function useVaultBalance(): { balance: number | null; loading: boolean; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const { state: vaultState } = useVault()
  const pm = managers?.permissionsManager
  // The zero-read window: both transfer paths note 'preparing' BEFORE their
  // createAction and stay busy until the broadcast settles (transfers.ts).
  const transferInFlight = vaultState.phase === 'preparing' || vaultState.phase === 'broadcasting'
  const balance = useSyncExternalStore(subscribe, () => (cacheKey === pm ? cached : null))
  const refreshVersion = useSyncExternalStore(subscribe, () => version)
  const [loading, setLoading] = useState(false)
  // Read the latest figure without making balance changes trigger another read.
  const balanceRef = useRef<number | null>(null)
  balanceRef.current = balance
  const inFlightRef = useRef(false)
  const pendingRef = useRef<(() => Promise<void>) | null>(null)

  const refresh = useCallback(() => {
    bumpVersion()
  }, [])

  useEffect(() => {
    let cancelled = false
    if (transferInFlight || !pm) {
      setLoading(false)
      return
    }

    const read = async () => {
      if (balanceRef.current === null) setLoading(true)
      try {
        const next = await getVaultBalance(pm as unknown as VaultWallet, adminOriginator)
        if (!cancelled) commitRead(pm, next)
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
  }, [pm, adminOriginator, txStatusVersion, transferInFlight, refreshVersion])

  return { balance, loading, refresh }
}
