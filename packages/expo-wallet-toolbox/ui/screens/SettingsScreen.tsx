import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * WalletHomeScreen.tsx's/PayScreen.tsx's lazy expo-router load.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

const CACHE_DURATION = 30000

export function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { router } = loadExpoRouter()
  const { managers, adminOriginator, selectedNetwork, txStatusVersion } = useWallet()

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const balanceCacheTimestampKey = `cached_wallet_balance_ts_${selectedNetwork}`
  const [accountBalance, setAccountBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Fetch wallet balance — keep last known value visible during network switch
  const refreshBalance = useCallback(async () => {
    if (!managers.permissionsManager) return
    try {
      const { totalOutputs } = await managers.permissionsManager.listOutputs(
        { basket: sdk.specOpWalletBalance },
        adminOriginator
      )
      const total = totalOutputs ?? 0
      setAccountBalance(total)
      setBalanceLoading(false)
      await Promise.all([
        AsyncStorage.setItem(balanceCacheKey, String(total)),
        AsyncStorage.setItem(balanceCacheTimestampKey, String(Date.now()))
      ])
    } catch (e) {
      console.error('Error refreshing balance:', e)
      setBalanceLoading(false)
    }
  }, [managers, adminOriginator, balanceCacheKey, balanceCacheTimestampKey])

  useEffect(() => {
    if (!managers.permissionsManager) {
      setAccountBalance(null)
      return
    }

    let cancelled = false
    ;(async () => {
      const [cached, ts] = await Promise.all([
        AsyncStorage.getItem(balanceCacheKey),
        AsyncStorage.getItem(balanceCacheTimestampKey)
      ])
      if (cancelled) return
      if (cached !== null) {
        setAccountBalance(Number(cached))
        if (!ts || Date.now() - Number(ts) > CACHE_DURATION) {
          setBalanceLoading(true)
          refreshBalance()
        }
      } else {
        setBalanceLoading(true)
        refreshBalance()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [managers.permissionsManager, refreshBalance, balanceCacheKey, balanceCacheTimestampKey])

  // Re-fetch whenever a transaction lands (deposit, withdrawal, anything that
  // bumps txStatusVersion) instead of waiting out the cache TTL — skip the
  // initial mount, which the effect above already covers.
  const mountedRef = React.useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    refreshBalance()
  }, [txStatusVersion, refreshBalance])

  return (
    <View style={{ backgroundColor: colors.backgroundSecondary }}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
        {/* ── Balance ── */}
        <View style={localStyles.balanceContainer}>
          <Text style={[localStyles.balanceLabel, { color: colors.textSecondary }]}>{t('you_have')}</Text>
          <Text
            onPress={refreshBalance}
            style={[localStyles.balanceAmount, { color: colors.textPrimary, opacity: balanceLoading ? 0.4 : 1 }]}
          >
            {accountBalance !== null ? <AmountDisplay abbreviate>{accountBalance}</AmountDisplay> : '...'}
          </Text>
        </View>

        {/* ── Activity ── */}
        <GroupedSection header={t('activity')}>
          <ListRow
            label={t('transactions')}
            icon="receipt-outline"
            iconColor="#32ADE6"
            onPress={() => router.push('/transactions')}
          />
          {/* One row for every money path. Direction and counterparty are chosen
              inside /pay, where the transport is inferred rather than picked —
              which is why four rows (and the identity-key QR, now Get paid →
              handle) collapse into this one. */}
          <ListRow
            label={t('payments')}
            icon="swap-horizontal-outline"
            iconColor={colors.success}
            onPress={() => router.push('/pay')}
          />
          <ListRow
            label={t('vault_row_title')}
            icon="safe"
            iconFamily="material-community"
            iconColor="#30B0C7"
            onPress={() => router.push('/vault' as any)}
            isLast
          />
        </GroupedSection>

        {/* ── Settings drill-down ── */}
        <GroupedSection>
          <ListRow
            label={t('settings')}
            icon="settings-outline"
            iconColor="#636366"
            onPress={() => router.push('/wallet-config')}
            isLast
          />
        </GroupedSection>
      </ScrollView>
    </View>
  )
}

const localStyles = StyleSheet.create({
  /* ── Balance ── */
  balanceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 100,
    paddingHorizontal: spacing.lg
  },
  balanceLabel: {
    ...typography.subhead,
    marginBottom: spacing.xs
  },
  balanceAmount: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
    minHeight: 42,
    lineHeight: 42
  }
})
