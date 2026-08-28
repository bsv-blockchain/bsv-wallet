/**
 * The inline success / error banner both handle cells use.
 *
 * Copied verbatim out of app/payments.tsx so the two cells report results the
 * same way the old screen did.
 */
import React from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { spacing, typography, radii } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
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

interface ResultBannerProps {
  readonly result: { type: 'success' | 'error'; message: string }
  readonly onDismiss: () => void
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
}

export default function ResultBanner({ result, onDismiss, colors }: ResultBannerProps) {
  const Ionicons = loadIonicons()
  const isSuccess = result.type === 'success'
  const color = isSuccess ? colors.success : colors.error
  return (
    <View style={[styles.resultBanner, { backgroundColor: color + '15', borderColor: color }]}>
      <Ionicons name={isSuccess ? 'checkmark-circle' : 'alert-circle'} size={20} color={color} />
      <Text style={[styles.resultText, { color }]}>{result.message}</Text>
      <TouchableOpacity onPress={onDismiss} style={styles.resultDismiss}>
        <Ionicons name="close" size={18} color={color} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  resultBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    marginBottom: spacing.lg
  },
  resultText: {
    ...typography.subhead,
    fontWeight: '500',
    flex: 1
  },
  resultDismiss: {
    padding: spacing.xs
  }
})
