// Polyfill AbortSignal.timeout for Hermes (React Native JS engine)
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

import '../wdyr' // dev-only re-render tracking; must run before any component renders
import '@/utils/devMenu' // dev-only profiling controls in the expo-dev-client menu

import React, { useEffect } from 'react'
import { View, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import packageJson from '../package.json'
import {
  UserContextProvider,
  type NativeHandlers,
  WalletContextProvider,
  useWallet,
  ExchangeRateContextProvider,
  ThemeProvider,
  LocalStorageProvider,
  VaultProvider,
  LanguageProvider,
  WalletConnectionProvider,
  configureToolbox
} from '@bsv/expo-wallet-toolbox'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import { PermissionSheet, AlertHost, ToastHost, showToast, ErrorBoundary } from '@bsv/expo-wallet-toolbox/ui'
import { VaultCeremonySheet } from '@bsv/expo-wallet-toolbox/ui'

import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Install the toolbox's runtime configuration before anything from the package
 * renders or builds a wallet.
 *
 * The EXPO_PUBLIC_* reads live here, in app source, on purpose: Expo's Babel
 * preset does not inline them inside node_modules, so the same reads made
 * within @bsv/expo-wallet-toolbox are undefined in any production bundle that
 * installs the package from npm. Reading here and passing the values in keeps
 * one code path for every consumer.
 *
 * backupUrl: null (no EXPO_PUBLIC_BACKUP_URL) disables backup entirely — that is
 * what a plain local `npm run ios` with no .env.local gets. The EAS development,
 * dev-physical and production profiles set it; preview-apk carries no env block
 * at all. See eas.json.
 *
 * vaultEnabled: the YubiKey vault's release gate (its spec §0 / §5.5). Only
 * the literal string "true" turns it on. The development, dev-physical and
 * production profiles set EXPO_PUBLIC_VAULT_ENABLED (production since
 * 2026-09-11 so TestFlight builds can exercise the vault on device); remove it
 * from production to ship a store build with the vault hidden.
 */
configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
  vaultEnabled: process.env.EXPO_PUBLIC_VAULT_ENABLED === 'true',
  services: {
    main: {
      arcUrl: process.env.EXPO_PUBLIC_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_WOC_API_KEY
    },
    test: {
      arcUrl: process.env.EXPO_PUBLIC_TEST_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_TEST_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_TEST_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_TEST_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_TEST_TAAL_API_KEY
    },
    teratest: {
      arcUrl: process.env.EXPO_PUBLIC_TERATEST_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_TERATEST_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_TERATEST_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_TERATEST_WOC_API_KEY
    }
  }
})

export const FIRST_TOUCH_DATE_KEY = 'firstTouchDate'

const nativeHandlers: NativeHandlers = {
  isFocused: async () => false,
  onFocusRequested: async () => {},
  onFocusRelinquished: async () => {},
  onDownloadFile: async (fileData: Blob, fileName: string) => {
    try {
      const url = window.URL.createObjectURL(fileData)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
      return true
    } catch (error) {
      console.error('Download failed:', error)
      return false
    }
  }
}

// Record the date of first app launch (never overwritten)
function FirstTouchRecorder() {
  useEffect(() => {
    AsyncStorage.getItem(FIRST_TOUCH_DATE_KEY).then(existing => {
      if (!existing) {
        AsyncStorage.setItem(FIRST_TOUCH_DATE_KEY, new Date().toISOString())
      }
    })
  }, [])
  return null
}

// Surfaces background local-payment internalization (e.g. a payment queued
// while offline that was internalized after wallet build or on reconnect)
// via the existing global ToastHost snackbar, so it is visible from any
// screen — not just the local-payments screen itself.
function LocalPayNotificationBridge() {
  const { localPayNotification, clearLocalPayNotification } = useWallet()

  useEffect(() => {
    if (!localPayNotification) return
    showToast(localPayNotification.message, { type: localPayNotification.type })
    clearLocalPayNotification()
  }, [localPayNotification, clearLocalPayNotification])

  return null
}

export default function RootLayout() {
  const isDark = useColorScheme() === 'dark'
  // Root canvas — the colour every screen's own background sits on during
  // transitions, so it has to be the theme's canvas, not pure black/white.
  const backgroundColor = isDark ? '#0C0E12' : '#FFFFFF'

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <LanguageProvider>
          <LocalStorageProvider>
            <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName="BSV Wallet">
              <ExchangeRateContextProvider>
                <WalletContextProvider onToast={showToast}>
                  <ThemeProvider>
                    <WalletConnectionProvider walletName="BSV Wallet">
                      <VaultProvider onToast={showToast}>
                        <View style={{ flex: 1, backgroundColor }}>
                          <FirstTouchRecorder />
                          {/* <TranslationTester /> */}
                          <PermissionSheet />
                          <VaultCeremonySheet />
                          <LocalPayNotificationBridge />
                          <AlertHost />
                          <Stack
                            screenOptions={{
                              animation: 'slide_from_right',
                              headerShown: false,
                              contentStyle: { backgroundColor },
                              // Every screen stays upright.
                              orientation: 'portrait_up'
                            }}
                          >
                            {/* The Wallet (index) takes no params, so there is only
                                one identity to collapse — `dangerouslySingular` keeps
                                repeated navigations to '/' returning to the existing
                                screen instead of stacking live duplicates. */}
                            <Stack.Screen name="index" dangerouslySingular />
                            <Stack.Screen name="auth/mnemonic" />
                            <Stack.Screen name="transactions" />
                            <Stack.Screen name="wallet-config" />
                            <Stack.Screen name="wallet-check" />
                            <Stack.Screen name="vault" />
                            <Stack.Screen name="vault-transfer" />
                            <Stack.Screen name="pay" />
                            {/* The three below become redirect stubs into /pay (Task 14).
                                They stay registered so an old link resolves instead of
                                hitting +not-found. */}
                            <Stack.Screen name="legacy-payments" />
                            <Stack.Screen name="payments" />
                            <Stack.Screen name="local-payments" />
                            <Stack.Screen name="connections" />
                            <Stack.Screen name="pair" />
                            <Stack.Screen name="not-found" />
                          </Stack>
                          <ToastHost />
                        </View>
                      </VaultProvider>
                    </WalletConnectionProvider>
                  </ThemeProvider>
                </WalletContextProvider>
              </ExchangeRateContextProvider>
            </UserContextProvider>
          </LocalStorageProvider>
        </LanguageProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  )
}
