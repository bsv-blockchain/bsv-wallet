import React, { useCallback, useEffect } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTheme, useWallet } from '@bsv/expo-wallet-toolbox'
import AmountDisplay from './AmountDisplay'
import AppLogo from '../ui/AppLogo'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'

// XR-058: scoped by network (matching useSpendableBalance's pattern) rather
// than a single global key, so one wallet/network context can never read
// back a figure cached by another. See WalletContext.tsx's logout sweep for
// the migration cleanup of the legacy unscoped key this replaces.
const BALANCE_CACHE_PREFIX = 'cached_wallet_balance_'
const CACHE_DURATION = 30000 // 30 seconds

export default function Balance() {
  const { colors } = useTheme()
  const { managers, adminOriginator, txStatusVersion, selectedNetwork } = useWallet()
  const cacheKey = `${BALANCE_CACHE_PREFIX}${selectedNetwork}`
  const timestampKey = `${cacheKey}_timestamp`
  // { key, value } rather than a bare number: `key` is compared against the
  // live `cacheKey` everywhere below, so a figure read for a since-departed
  // wallet or network context can never be painted, even if this component
  // stays mounted across a logout or network switch (XR-058).
  const [accountBalance, setAccountBalance] = React.useState<{ key: string; value: number } | null>(null)
  const [balanceLoading, setBalanceLoading] = React.useState(false)
  // Read through a ref, not the state value: `accountBalance` in this callback's
  // deps would give it a new identity on every fetch, re-running both effects
  // below and firing a second, pointless fetch each time the figure changes.
  const accountBalanceRef = React.useRef<{ key: string; value: number } | null>(null)
  accountBalanceRef.current = accountBalance

  const refreshBalance = useCallback(async () => {
    try {
      if (!managers.permissionsManager) {
        // No active wallet context for this network: never leave a previous
        // context's figure on screen (XR-058).
        setAccountBalance(null)
        return
      }

      // Only show loading if we don't have cached data for this context
      if (accountBalanceRef.current?.key !== cacheKey) {
        setBalanceLoading(true)
      }

      // Fetch the first page
      const { totalOutputs } = await managers.permissionsManager.listOutputs(
        { basket: sdk.specOpWalletBalance },
        adminOriginator
      )

      const total = totalOutputs ?? 0
      setAccountBalance({ key: cacheKey, value: total })

      // Cache the new balance
      await Promise.all([AsyncStorage.setItem(cacheKey, String(total)), AsyncStorage.setItem(timestampKey, String(Date.now()))])

      setBalanceLoading(false)
    } catch (e) {
      console.error('Error refreshing balance:', e)
      setBalanceLoading(false)
    }
  }, [managers, adminOriginator, cacheKey, timestampKey])

  // Load cached balance immediately on mount — but only once a wallet
  // context for this exact network is active. Reading (and painting) the
  // cache before that is exactly how a departed wallet's figure used to leak
  // into a fresh or different-context mount (XR-058).
  useEffect(() => {
    let mounted = true

    const loadCachedBalance = async () => {
      if (!managers.permissionsManager) {
        if (mounted) setAccountBalance(null)
        return
      }
      try {
        const [cachedBalance, cachedTimestamp] = await Promise.all([
          AsyncStorage.getItem(cacheKey),
          AsyncStorage.getItem(timestampKey)
        ])

        if (!mounted || !managers.permissionsManager) return

        if (cachedBalance !== null) {
          const balance = Number(cachedBalance)
          const timestamp = Number(cachedTimestamp)
          const isRecent = timestamp && Date.now() - timestamp < CACHE_DURATION

          setAccountBalance({ key: cacheKey, value: balance })

          // If cache is old, fetch fresh data
          if (!isRecent) {
            refreshBalance()
          }
        } else {
          // No cache, fetch fresh data
          refreshBalance()
        }
      } catch (error) {
        console.error('Error loading cached balance:', error)
        if (mounted) refreshBalance()
      }
    }

    loadCachedBalance()
    return () => {
      mounted = false
    }
  }, [refreshBalance, cacheKey, managers.permissionsManager])

  // Refresh balance when SSE reports a transaction status change
  useEffect(() => {
    if (txStatusVersion > 0) {
      refreshBalance()
    }
  }, [txStatusVersion, refreshBalance])

  const balance = accountBalance?.key === cacheKey ? accountBalance.value : null

  return (
    <View style={[componentStyles.container, { backgroundColor: colors.paperBackground }]}>
      <Text style={[componentStyles.sectionTitle, { color: colors.textPrimary }]}>you have</Text>
      {balance === null && balanceLoading ? (
        <View style={componentStyles.loadingContainer}>
          <AppLogo size={50} rotate />
        </View>
      ) : (
        <Text onPress={refreshBalance} style={[componentStyles.balance, { color: colors.textPrimary }]}>
          <AmountDisplay abbreviate>{balance ?? 0}</AmountDisplay>
          <Text style={[componentStyles.cacheIndicator, { color: colors.textSecondary }]}></Text>
        </Text>
      )}
    </View>
  )
}

const componentStyles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 12
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center'
  },
  balance: {
    fontSize: 30,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  cacheIndicator: {
    fontSize: 16,
    fontWeight: 'normal'
  }
})
