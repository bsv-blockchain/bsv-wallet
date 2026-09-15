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
  /**
   * The one thing a failed money message may offer to DO — "Check again" after
   * an overlay this wallet could not reach, "Get BSV" after a funding refusal.
   *
   * Deliberately not a retry. When a submit fails without a verdict, the
   * transaction may have been admitted and the response lost; a retry would
   * build a second spend of the same coins and be refused for conservation
   * forever. So the action offered is always one that reads state, never one
   * that moves money.
   */
  readonly action?: { readonly label: string; readonly onPress: () => void }
}

export default function ResultBanner({ result, onDismiss, colors, action }: ResultBannerProps) {
  const Ionicons = loadIonicons()
  const isSuccess = result.type === 'success'
  const color = isSuccess ? colors.success : colors.error
  return (
    <View style={[styles.resultBanner, { backgroundColor: color + '15', borderColor: color }]}>
      <Ionicons name={isSuccess ? 'checkmark-circle' : 'alert-circle'} size={20} color={color} />
      <View style={styles.resultBody}>
        <Text style={[styles.resultText, { color }]}>{result.message}</Text>
        {action && (
          <TouchableOpacity
            onPress={action.onPress}
            // A footnote-sized target is not a target: padded to the 44pt
            // minimum in the direction it can grow.
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.resultAction}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Text style={[styles.resultActionText, { color }]}>{action.label}</Text>
          </TouchableOpacity>
        )}
      </View>
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
  resultBody: {
    flex: 1,
    gap: spacing.xs
  },
  resultText: {
    ...typography.subhead,
    fontWeight: '500'
  },
  resultAction: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  resultActionText: {
    ...typography.subhead,
    fontWeight: '700'
  },
  resultDismiss: {
    padding: spacing.xs
  }
})
