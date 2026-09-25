import { loadUserAvatarIcon } from '@bsv/expo-wallet-toolbox'

// Polyfill AbortSignal.timeout for Hermes (React Native JS engine)
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

// The stored avatar choice. Fire-and-forget: until it resolves every "you"
// shows the default disc, which is also what an unset choice means.
void loadUserAvatarIcon()

import '../wdyr' // dev-only re-render tracking; must run before any component renders
import '@/utils/devMenu' // dev-only profiling controls in the expo-dev-client menu
import { AgentationGate } from '@/utils/AgentationGate'

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
 * the literal string "true" turns it on. EAS development, dev-physical and
 * production enable it. Production was re-enabled on 2026-09-25 by owner
 * decision after every existing vault was emptied, so only v7 outputs exist
 * (docs/security/external-review-closure.md, "Owner decision"). With it off,
 * no Vault output is created (deposit, re-lock, withdrawal remainder), while
 * an existing vault stays reachable for a full withdrawal.
 */
configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
  vaultEnabled: process.env.EXPO_PUBLIC_VAULT_ENABLED === 'true',
  // Mandala stablecoin endpoints, per chain. A chain without a complete entry
  // has no token runtime: the wallet neither drains the 'mandala-payments'
  // MessageBox nor offers token assets in Pay / Get paid on that chain.
  // `main` comes from EXPO_PUBLIC_MANDALA_* (unset in the production profile
  // until a mainnet overlay is deployed); `test` from EXPO_PUBLIC_TEST_MANDALA_*
  // (the flux testnet overlay, mandala-test-overlay.bsvblockchain.tech).
  mandala: {
    main: {
      overlayUrl: process.env.EXPO_PUBLIC_MANDALA_OVERLAY_URL ?? '',
      overlayIdentityKey: process.env.EXPO_PUBLIC_MANDALA_OVERLAY_IDENTITY_KEY ?? '',
      messageBoxUrl:
        process.env.EXPO_PUBLIC_MANDALA_MESSAGEBOX_URL ??
        process.env.EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL ??
        'https://gmb.bsvblockchain.tech'
    },
    test: {
      overlayUrl: process.env.EXPO_PUBLIC_TEST_MANDALA_OVERLAY_URL ?? '',
      overlayIdentityKey: process.env.EXPO_PUBLIC_TEST_MANDALA_OVERLAY_IDENTITY_KEY ?? '',
      messageBoxUrl:
        process.env.EXPO_PUBLIC_TEST_MANDALA_MESSAGEBOX_URL ??
        process.env.EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL ??
        'https://gmb.bsvblockchain.tech'
    }
  },
  // The paymail handle registry, per chain: the domain this build's handles
  // live under and the host that serves it. A chain with no complete entry
  // shows "not available yet" in Profile and adds no registry tier to Pay.
  // The EAS development and dev-physical profiles point both chains at
  // deggen.com served by messagebox.bsvblockchain.tech; production carries
  // neither until a production domain is decided.
  handleRegistry: {
    main: {
      domain: process.env.EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN ?? '',
      url: process.env.EXPO_PUBLIC_HANDLE_REGISTRY_URL ?? ''
    },
    test: {
      domain: process.env.EXPO_PUBLIC_TEST_HANDLE_REGISTRY_DOMAIN ?? '',
      url: process.env.EXPO_PUBLIC_TEST_HANDLE_REGISTRY_URL ?? ''
    }
  },
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

const nativeHandlers: NativeHandlers = {
  isFocused: async () => false,
  onFocusRequested: async () => {},
  onFocusRelinquished: async () => {}
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
                        <AgentationGate>
                          <View style={{ flex: 1, backgroundColor }}>
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
                        </AgentationGate>
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
