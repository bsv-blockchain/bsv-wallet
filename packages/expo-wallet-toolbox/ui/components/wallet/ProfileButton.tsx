/**
 * 34pt chrome-disc profile button, top-left of Home — passed through
 * `WalletHomeScreen`'s existing (previously unused) `topLeft` prop from the
 * host app's `app/index.tsx`, so this needed no package API change.
 */
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '@bsv/expo-wallet-toolbox'
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
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()
  return (
    <PressableScale
      onPress={() => router.push('/profile' as never)}
      haptic="tap"
      style={[styles.disc, { backgroundColor: colors.fillTertiary }]}
      accessibilityRole="button"
      accessibilityLabel="Profile"
    >
      <View style={styles.iconWrap}>
        <Ionicons name="person" size={17} color={colors.textSecondary} />
      </View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  disc: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  iconWrap: { alignItems: 'center', justifyContent: 'center' }
})
