/**
 * The states the app previously had no way to show.
 *
 * Before the envelope, a failed key read was indistinguishable from having no
 * wallet: the build silently bailed and the user landed in the browser as if
 * they were new. Now that the OS genuinely holds the key, three outcomes need
 * to be visible and told apart:
 *
 *  - `lost`        the OS destroyed the key (biometrics re-enrolled, screen
 *                  lock removed, app reinstalled). Unrecoverable on-device.
 *  - `cancelled`   the user dismissed the sheet. Nothing was touched; retry.
 *  - `unavailable` biometric lockout or no usable hardware.
 *
 * Nothing here wipes anything on its own. Restoring is an explicit, confirmed
 * act, because the alternative — auto-wiping on a read failure — would destroy
 * a wallet over a transient prompt error.
 */
import React, { useCallback } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import PressableScale from '../ui/PressableScale'
import { showAlert } from '../ui/AlertCard'
import { useTheme, spacing, radii, typography, useLocalStorage, i18n } from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as the
 * expo-router load just below.
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-router's `router` singleton is required lazily (on first call from
 * onRestore()), rather than imported statically, because this file is
 * barrel-exported from the package's `ui` entry point — a static top-level
 * `import` of expo-router pulls in its own untransformed JSX source
 * (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's lazy expo-router load.
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

export default function WalletLockNotice() {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const { unlockState, unlock, deleteAllWalletKeys } = useLocalStorage()

  const onRestore = useCallback(async () => {
    const choice = await showAlert({
      title: t('wallet_lost_title'),
      message: t('wallet_lost_body'),
      buttons: [
        { text: t('wallet_lost_later'), style: 'cancel', key: 'cancel' },
        { text: t('wallet_lost_restore'), style: 'destructive', key: 'restore' }
      ]
    })
    if (choice !== 'restore') return
    // The ciphertexts are already unopenable; clearing them is what lets
    // onboarding start clean instead of tripping over an orphan sentinel.
    await deleteAllWalletKeys()
    loadExpoRouter().router.replace('/auth/mnemonic')
  }, [deleteAllWalletKeys])

  const status = unlockState.status
  if (status !== 'lost' && status !== 'cancelled' && status !== 'unavailable') return null

  const lost = status === 'lost'
  const body = lost
    ? t('wallet_lost_body')
    : status === 'unavailable' && unlockState.reason === 'lockout'
      ? t('wallet_lockout_body')
      : status === 'unavailable'
        ? t('wallet_no_biometrics_body')
        : t('wallet_locked_body')

  return (
    <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
      <Ionicons
        name={lost ? 'alert-circle-outline' : 'lock-closed-outline'}
        size={40}
        color={lost ? colors.textPrimary : colors.textTertiary}
      />
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {lost ? t('wallet_lost_title') : t('wallet_locked_title')}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{body}</Text>

      <PressableScale
        haptic="confirm"
        onPress={lost ? onRestore : unlock}
        style={[styles.primary, { backgroundColor: colors.accent }]}
      >
        <Text style={styles.primaryText}>
          {lost ? t('wallet_lost_restore') : t('wallet_unlock_retry')}
        </Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    margin: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  title: { ...typography.title3, textAlign: 'center' },
  body: { ...typography.subhead, textAlign: 'center' },
  primary: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    marginTop: spacing.xs
  },
  primaryText: { ...typography.headline, color: '#fff' }
})
