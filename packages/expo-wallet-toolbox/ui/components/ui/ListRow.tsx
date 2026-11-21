import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing } from '@bsv/expo-wallet-toolbox'
import PressableScale from './PressableScale'
import {
  ArrowLeftRight,
  Banknote,
  Bell,
  Bitcoin,
  Bug,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheckBig,
  CirclePlus,
  CircleX,
  Clock,
  CloudUpload,
  Download,
  FlaskConical,
  Globe,
  KeyRound,
  LockOpen,
  LogOut,
  Mail,
  QrCode,
  Radio,
  Receipt,
  RefreshCw,
  Send,
  Server,
  Settings,
  Share2,
  ShieldCheck,
  Terminal,
  Trash2,
  Vault,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react-native'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Both icon sets are loaded lazily, only when actually rendering, same
 * pattern as this package's other native-module-boundary fixes (expo-router,
 * expo-blur). They are now only reached by a row whose icon name has no
 * lucide equivalent below.
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
    materialCommunityIconsComponent = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@expo/vector-icons').MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

/**
 * Every glyph this app draws comes from lucide -- its settings rows
 * (src/settings/Rows.tsx), its headers, its sheets -- so the rows here draw
 * from it too, at the same 16px and the same default stroke. Two icon
 * families in one list is visible at a glance: Ionicons' filled-corner,
 * closed shapes next to lucide's open 2px strokes read as two apps.
 *
 * The prop stays an Ionicons (or MaterialCommunityIcons) name, because that
 * is this component's published API and every call site passes one. This maps
 * each name used across the package to its nearest lucide counterpart; a name
 * with no entry falls through to the set it was written for, so a row added
 * upstream still draws something rather than nothing.
 */
const LUCIDE: Record<string, LucideIcon> = {
  'add-circle-outline': CirclePlus,
  'alert-circle-outline': CircleAlert,
  'bug-outline': Bug,
  'cash-outline': Banknote,
  'checkmark-done-circle-outline': CircleCheckBig,
  'close-circle-outline': CircleX,
  'cloud-upload-outline': CloudUpload,
  'construct-outline': Wrench,
  'download-outline': Download,
  'flash-outline': Zap,
  'flask-outline': FlaskConical,
  'globe-outline': Globe,
  'key-outline': KeyRound,
  'lock-open': LockOpen,
  'log-out-outline': LogOut,
  'logo-bitcoin': Bitcoin,
  'mail-outline': Mail,
  'notifications-outline': Bell,
  'qr-code-outline': QrCode,
  'radio-outline': Radio,
  'receipt-outline': Receipt,
  'refresh-outline': RefreshCw,
  // MaterialCommunityIcons' `safe` -- the one concept Ionicons had no glyph
  // for, and the reason iconFamily exists. lucide has it.
  safe: Vault,
  'send-outline': Send,
  'server-outline': Server,
  'settings-outline': Settings,
  'share-outline': Share2,
  'shield-checkmark-outline': ShieldCheck,
  'swap-horizontal-outline': ArrowLeftRight,
  'terminal-outline': Terminal,
  'time-outline': Clock,
  'trash-outline': Trash2,
  'wifi-outline': Wifi
}

interface ListRowProps {
  label: string
  /** Secondary line under the label. Settings rows use this for the explaining copy. */
  subtitle?: string
  value?: string
  /** Ionicons name by default; a MaterialCommunityIcons name when
   * `iconFamily="material-community"`. Drawn as its lucide equivalent, which
   * is what the rest of this app draws. */
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
  testID?: string
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
  isLast = false,
  testID
}) => {
  const { colors } = useTheme()
  const Glyph = icon ? LUCIDE[icon as string] : undefined
  const Chevron = chevronDown ? ChevronDown : ChevronRight

  const content = (
    <View style={styles.container}>
      {icon && (
        <View
          style={[
            styles.iconContainer,
            iconColor
              ? { backgroundColor: iconColor + '1A', borderColor: iconColor + '2E' }
              : { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
          ]}
        >
          {Glyph ? (
            <Glyph size={16} color={iconColor || colors.textPrimary} />
          ) : iconFamily === 'material-community' ? (
            React.createElement(loadMaterialCommunityIcons(), {
              name: icon as never,
              size: 16,
              color: iconColor || colors.textPrimary
            })
          ) : (
            React.createElement(loadIonicons(), {
              name: icon as never,
              size: 16,
              color: iconColor || colors.textPrimary
            })
          )}
        </View>
      )}
      <View style={styles.textColumn}>
        <Text style={[styles.label, { color: destructive ? colors.error : colors.textPrimary }]} numberOfLines={1}>
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
          <Chevron size={16} color={colors.textSecondary} style={styles.chevron} />
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
        testID={testID}
        accessibilityLabel={value ? `${label}, ${value}` : label}
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
    paddingHorizontal: spacing.md,
    borderRadius: 19.04
  },
  // A well the glyph sits in, tinted by the row's own colour rather than
  // flooded with it. A grid of saturated tiles reads as decoration and makes
  // every row shout equally; the tint keeps the category cue and drops the
  // shouting.
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 19.04,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  textColumn: {
    flex: 1
  },
  label: {
    fontFamily: 'Nunito',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500'
  },
  subtitle: {
    fontFamily: 'Nunito',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: spacing.sm
  },
  value: {
    fontFamily: 'Nunito',
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 200
  },
  chevron: {
    marginLeft: spacing.xs
  }
})
