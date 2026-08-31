import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing, typography } from '@bsv/expo-wallet-toolbox'
import PressableScale from './PressableScale'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Both icon sets are loaded lazily, only when actually rendering, same
 * pattern as this package's other native-module-boundary fixes (expo-router,
 * expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
type MaterialCommunityIconsComponent = typeof import('@expo/vector-icons').MaterialCommunityIcons
let ioniconsComponent: IoniconsComponent | undefined
let materialCommunityIconsComponent: MaterialCommunityIconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}
function loadMaterialCommunityIcons(): MaterialCommunityIconsComponent {
  if (!materialCommunityIconsComponent) {
    materialCommunityIconsComponent = require('@expo/vector-icons')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

interface ListRowProps {
  label: string
  /** Secondary line under the label. Settings rows use this for the explaining copy. */
  subtitle?: string
  value?: string
  /** Ionicons name by default; a MaterialCommunityIcons name when
   * `iconFamily="material-community"`. */
  icon?: keyof IoniconsComponent['glyphMap'] | keyof MaterialCommunityIconsComponent['glyphMap']
  /** Ionicons covers almost everything here, but a few concepts have no glyph
   * in it (e.g. a bank vault — `lock-closed` reads as a generic padlock).
   * Opt into MaterialCommunityIcons per row for those. */
  iconFamily?: 'ionicons' | 'material-community'
  iconColor?: string
  onPress?: () => void
  showChevron?: boolean
  chevronDown?: boolean
  destructive?: boolean
  trailing?: React.ReactNode
  isLast?: boolean
}

/**
 * Standard row for iOS-style grouped lists.
 * Shows icon (optional), label, value/trailing, and chevron.
 */
export const ListRow: React.FC<ListRowProps> = ({
  label,
  subtitle,
  value,
  icon,
  iconFamily = 'ionicons',
  iconColor,
  onPress,
  showChevron = true,
  chevronDown = false,
  destructive = false,
  trailing,
  isLast = false
}) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const MaterialCommunityIcons = loadMaterialCommunityIcons()

  const content = (
    <View style={[styles.container, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
      {icon && (
        <View
          style={[
            styles.iconContainer,
            iconColor
              ? { backgroundColor: iconColor + '1A', borderColor: iconColor + '2E' }
              : { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
          ]}
        >
          {iconFamily === 'material-community' ? (
            <MaterialCommunityIcons
              name={icon as keyof typeof MaterialCommunityIcons.glyphMap}
              size={17}
              color={iconColor || colors.textSecondary}
            />
          ) : (
            <Ionicons
              name={icon as keyof typeof Ionicons.glyphMap}
              size={17}
              color={iconColor || colors.textSecondary}
            />
          )}
        </View>
      )}
      <View style={styles.textColumn}>
        <Text
          style={[
            styles.label,
            { color: destructive ? colors.error : colors.textPrimary }
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {trailing}
        {value && !trailing && (
          <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
            {value}
          </Text>
        )}
        {showChevron && onPress && !destructive && (
          <Ionicons
            name={chevronDown ? 'chevron-down' : 'chevron-forward'}
            size={18}
            color={colors.textQuaternary}
            style={styles.chevron}
          />
        )}
      </View>
    </View>
  )

  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        scaleTo={0.98}
        haptic="tap"
      >
        {content}
      </PressableScale>
    )
  }

  return content
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  // A well the glyph sits in, tinted by the row's own colour rather than
  // flooded with it. A grid of saturated tiles reads as decoration and makes
  // every row shout equally; the tint keeps the category cue and drops the
  // shouting.
  iconContainer: {
    width: 28,
    height: 28,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  textColumn: {
    flex: 1,
  },
  label: {
    ...typography.body,
  },
  subtitle: {
    ...typography.footnote,
    marginTop: 1,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: spacing.sm,
  },
  value: {
    ...typography.body,
    maxWidth: 200,
  },
  chevron: {
    marginLeft: spacing.xs,
  },
})
