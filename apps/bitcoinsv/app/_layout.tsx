// Polyfill AbortSignal.timeout for Hermes.
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

import React, { useEffect } from 'react'
import { Appearance, LogBox, View, useColorScheme } from 'react-native'
import { Stack, usePathname } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { hideSplash } from '../src/ui/splash'
import { StatusBar } from 'expo-status-bar'
import Constants from 'expo-constants'
import * as SystemUI from 'expo-system-ui'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
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
  configureToolbox,
  loadUserAvatarIcon
} from '@bsv/expo-wallet-toolbox'
import { PermissionSheet, AlertHost, ToastHost, ErrorBoundary, VaultCeremonySheet } from '@bsv/expo-wallet-toolbox/ui'
// Host adapter shared with the existing app: it wraps React Native Firebase and
// holds no state, so reusing it shares code, not storage.
import { firebasePushAdapter } from '../../../utils/push/firebasePushAdapter'
import { withAppRouting } from '../src/notify/pushRouting'
import { devPushAdapter } from '../src/notify/devPushAdapter'
import packageJson from '../package.json'
import { usePalette } from '../src/theme'
import { TourVideoHost } from '../src/tour/TourVideo'
import { FeedbackHost } from '../src/feedback/FeedbackHost'
// the prototype's sonner toasts, Undo and money toasts in one stack; the
// core's ToastHost stays for the core's own screens
import { ToastHost as AppToastHost, showToast } from '../src/ui/Toast'
import { usePrefs } from '../src/state/prefs'
import { WalletLooksSync } from '../src/state/walletLooks'
import { TapHost } from '../src/ui/TapHint'
import { RequestsBridge } from '../src/requests/useRequests'
import { PaymentAlertsBridge, walletToast } from '../src/notify/PaymentAlerts'

const APP_NAME = 'Bitcoin SV Wallet'

// Development builds only: a rate refresh that fails is handled by the core
// (it keeps the last rate) but logged as an error, and LogBox's banner would
// sit over the screen's bottom buttons
LogBox.ignoreLogs(['Error refreshing exchange rate'])

void loadUserAvatarIcon()

// The native splash stays (iOS: Home's top; Android: the plain ground) until
// the first screen has drawn under it, then goes: no blank flash between them.
void SplashScreen.preventAutoHideAsync().catch(() => {})

/**
 * Toolbox runtime configuration, installed before anything builds a wallet.
 *
 * Same contract as the existing app's app/_layout.tsx: the EXPO_PUBLIC_* reads
 * live in host source because Expo only inlines them there. Values per build
 * profile are in this app's own eas.json.
 *
 * vaultEnabled: on in this app's development and preview profiles only, never
 * in production (decision of 2026-10-09; the demo is no authority to enable a
 * gated capability).
 *
 * push: needs both the profile flag and this app's own Firebase registration
 * (app.config.js extra.pushConfigured). Without the registration there is no
 * default Firebase app, so the adapter must not be wired in.
 */
const pushConfigured = Constants.expoConfig?.extra?.pushConfigured === true

configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
  vaultEnabled: process.env.EXPO_PUBLIC_VAULT_ENABLED === 'true',
  mandala: {
    main: {
      overlayUrl: process.env.EXPO_PUBLIC_MANDALA_OVERLAY_URL ?? '',
      overlayIdentityKey: process.env.EXPO_PUBLIC_MANDALA_OVERLAY_IDENTITY_KEY ?? '',
      messageBoxUrl:
        process.env.EXPO_PUBLIC_MANDALA_MESSAGEBOX_URL ??
        process.env.EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL ??
        'https://messagebox.bsvblockchain.tech'
    },
    test: {
      overlayUrl: process.env.EXPO_PUBLIC_TEST_MANDALA_OVERLAY_URL ?? '',
      overlayIdentityKey: process.env.EXPO_PUBLIC_TEST_MANDALA_OVERLAY_IDENTITY_KEY ?? '',
      messageBoxUrl:
        process.env.EXPO_PUBLIC_TEST_MANDALA_MESSAGEBOX_URL ??
        process.env.EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL ??
        'https://messagebox.bsvblockchain.tech'
    }
  },
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
  },
  // decision 7: handles from 1 character (the registry must accept them too)
  handleMinLength: 1,
  // Firebase when this build has it (push/ in docs/backend-integration.md), with
  // the app's own routing for request pushes; in development, the simulator
  // (EXPO_PUBLIC_PUSH_SIMULATE=true) plays pushes into the same routing
  push:
    process.env.EXPO_PUBLIC_PUSH_ENABLED === 'true' && pushConfigured
      ? withAppRouting(firebasePushAdapter)
      : __DEV__ && process.env.EXPO_PUBLIC_PUSH_SIMULATE === 'true'
        ? withAppRouting(devPushAdapter)
        : undefined
})

const nativeHandlers: NativeHandlers = {
  isFocused: async () => false,
  onFocusRequested: async () => {},
  onFocusRelinquished: async () => {}
}

// Background local-payment results surface as a toast from any screen.
function LocalPayNotificationBridge() {
  const { localPayNotification, clearLocalPayNotification } = useWallet()

  useEffect(() => {
    if (!localPayNotification) return
    showToast(localPayNotification.message, { type: localPayNotification.type })
    clearLocalPayNotification()
  }, [localPayNotification, clearLocalPayNotification])

  return null
}

// Settings → Dark mode: the phone's own setting until it's switched there
function ThemeFromPrefs() {
  const { theme, loaded } = usePrefs()
  useEffect(() => {
    if (loaded) Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme)
  }, [theme, loaded])
  return null
}

export default function RootLayout() {
  // The prototype's page background: warm paper in light mode, near-black in dark.
  const backgroundColor = usePalette().background
  const isDark = useColorScheme() === 'dark'
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(backgroundColor).catch(() => {})
  }, [backgroundColor])
  // The native splash stays until prefs are read, and then goes once the first
  // thing is drawn: Home in its own time (app/index.tsx), anything else that
  // opened first (a link, Welcome) at once; and, in case nothing ever says so,
  // everything after a few seconds.
  const { loaded } = usePrefs()
  const path = usePathname()
  useEffect(() => {
    if (!loaded || path === '/') return
    const t = setTimeout(hideSplash, 150)
    return () => clearTimeout(t)
  }, [loaded, path])
  useEffect(() => {
    const t = setTimeout(hideSplash, 4000)
    return () => clearTimeout(t)
  }, [])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <LanguageProvider>
          <LocalStorageProvider>
            <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName={APP_NAME}>
              <ExchangeRateContextProvider>
                {/* "Payment received" becomes the money toast (src/notify/PaymentAlerts) */}
                <WalletContextProvider onToast={walletToast}>
                  <ThemeProvider>
                    <WalletConnectionProvider walletName={APP_NAME}>
                      <VaultProvider onToast={showToast}>
                        <View style={{ flex: 1, backgroundColor }}>
                          {/* Dark icons on paper, light icons on the dark canvas. */}
                          <StatusBar style={isDark ? 'light' : 'dark'} />
                          <PermissionSheet />
                          <VaultCeremonySheet />
                          <LocalPayNotificationBridge />
                          <PaymentAlertsBridge />
                          <ThemeFromPrefs />
                          <WalletLooksSync />
                          <RequestsBridge />
                          <AlertHost />
                          <Stack
                            screenOptions={{
                              animation: 'slide_from_right',
                              headerShown: false,
                              contentStyle: { backgroundColor },
                              orientation: 'portrait_up'
                            }}
                          >
                            <Stack.Screen name="index" dangerouslySingular />
                            <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
                            {/* Pay and Scan & pay are two tabs of one page: switching
                                (router.replace) cross-fades in place, as the prototype's
                                route template does, rather than pushing sideways */}
                            <Stack.Screen name="send" options={{ animation: 'fade', animationDuration: 300 }} />
                            <Stack.Screen name="pay" options={{ animation: 'fade', animationDuration: 300 }} />
                          </Stack>
                          <TourVideoHost />
                          {/* "Enjoying Bitcoin SV Wallet?" and notes to the team */}
                          <FeedbackHost />
                          <AppToastHost />
                          <ToastHost />
                          <TapHost />
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

