import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme, hitTargets } from '@bsv/expo-wallet-toolbox'
import PressableScale from './PressableScale'

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

interface IconButtonProps {
  name: keyof IoniconsComponent['glyphMap']
  onPress: () => void
  onLongPress?: () => void
  size?: number
  color?: string
  disabled?: boolean
  badge?: number | string
  accessibilityLabel?: string
}

/**
 * Minimal icon button with proper 44pt hit target (iOS HIG).
 * Supports an optional numeric badge overlay.
 */
export const IconButton: React.FC<IconButtonProps> = ({
  name,
  onPress,
  onLongPress,
  size = 22,
  color,
  disabled = false,
  badge,
  accessibilityLabel
}) => {
  const { colors } = useTheme()
  const iconColor = color ?? colors.accent
  const Ionicons = loadIonicons()

  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      scaleTo={0.92}
      style={[
        styles.container,
        disabled && styles.disabled
      ]}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
    >
      <Ionicons name={name} size={size} color={iconColor} />
      {badge !== undefined && (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          {/* The accent inverts between themes, so the count has to ride on
              textOnAccent — a fixed white here is white-on-white in dark. */}
          <Text style={[styles.badgeText, { color: colors.textOnAccent }]}>
            {typeof badge === 'number' && badge > 99 ? '99+' : badge}
          </Text>
        </View>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  container: {
    width: hitTargets.minimum,
    height: hitTargets.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.3,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
})
