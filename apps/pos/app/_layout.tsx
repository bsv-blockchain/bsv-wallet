import React from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import {
  UserContextProvider,
  WalletContextProvider,
  ExchangeRateContextProvider,
  ThemeProvider,
  LocalStorageProvider,
  LanguageProvider,
  configureToolbox
} from '@bsv/expo-wallet-toolbox'
import { PermissionSheet, AlertHost, ToastHost, ErrorBoundary } from '@bsv/expo-wallet-toolbox/ui'
import { PosProvider } from '../src/context'
configureToolbox({ backupUrl: null, vaultEnabled: false })
const handlers = { isFocused: async () => false, onFocusRequested: async () => {}, onFocusRelinquished: async () => {} }
export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <ErrorBoundary>
          <LanguageProvider>
            <LocalStorageProvider>
              <UserContextProvider nativeHandlers={handlers} appName="BSV Point of Sale" appVersion="0.1.0">
                <ExchangeRateContextProvider>
                  <WalletContextProvider>
                    <ThemeProvider>
                      <PosProvider>
                        <Stack screenOptions={{ headerShown: false }} />
                        <PermissionSheet />
                        <AlertHost />
                        <ToastHost />
                      </PosProvider>
                    </ThemeProvider>
                  </WalletContextProvider>
                </ExchangeRateContextProvider>
              </UserContextProvider>
            </LocalStorageProvider>
          </LanguageProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
