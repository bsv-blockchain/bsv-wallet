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
import { UserContextProvider, NativeHandlers } from '../context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider, useWallet } from '@/context/WalletContext'
import { ExchangeRateContextProvider } from '@/context/ExchangeRateContext'
import { ThemeProvider } from '@/context/theme/ThemeContext'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import LocalStorageProvider from '@/context/LocalStorageProvider'
import PermissionSheet from '@/components/ui/PermissionSheet'
import { AlertHost } from '@/components/ui/AlertCard'
import { VaultProvider } from '@/context/VaultContext'
import { VaultCeremonySheet } from '@/components/vault/VaultCeremonySheet'
import { ToastHost, showToast } from '@/components/ui/Toast'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import { LanguageProvider } from '@/context/i18n/translations'
import { WalletConnectionProvider } from '@/context/WalletConnectionContext'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

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

// Deep link handler component
function DeepLinkHandler() {
  useDeepLinking()
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
                <WalletContextProvider>
                  <ThemeProvider>
                    <WalletConnectionProvider>
                      <VaultProvider>
                        <View style={{ flex: 1, backgroundColor }}>
                          <FirstTouchRecorder />
                          <DeepLinkHandler />
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
                            <Stack.Screen name="vault" />
                            <Stack.Screen name="vault-recover" />
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
