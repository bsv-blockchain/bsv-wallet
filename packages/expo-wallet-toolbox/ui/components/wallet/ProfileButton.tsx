/**
 * 34pt chrome-disc profile button, top-left of Home — passed through
 * `WalletHomeScreen`'s existing (previously unused) `topLeft` prop from the
 * host app's `app/index.tsx`, so this needed no package API change. Same disc
 * as the settings button on the right (surfaceRaised + hairline), so the two
 * bookend the header as a matched pair.
 */
import React from 'react'
import { StyleSheet } from 'react-native'
import { useTheme } from '@bsv/expo-wallet-toolbox'
import { useTranslation } from 'react-i18next'
import PressableScale from '../ui/PressableScale'

type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

export default function ProfileButton() {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()
  return (
    <PressableScale
      onPress={() => router.push('/profile' as never)}
      haptic="tap"
      hitSlop={5}
      style={[styles.disc, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
      accessibilityRole="button"
      accessibilityLabel={t('profile')}
    >
      <Ionicons name="person-outline" size={17} color={colors.textSecondary} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  disc: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
