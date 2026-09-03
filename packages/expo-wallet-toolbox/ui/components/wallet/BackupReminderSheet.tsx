/**
 * A non-blocking card anchored to the bottom of the screen on a freshly
 * auto-created wallet (balance zero, empty activity), prompting the user to
 * secure their keys before the screen fills up with real money and history.
 * Deliberately "attention" styled (warning-tinted border/icon) — this is the
 * one prompt in the app that guards against irreversible key loss — but it
 * must never trap the user: no backdrop, no Modal, rest of the screen stays
 * fully interactive underneath it (pointerEvents="box-none" on the wrapper).
 *
 * Advisory only, same as the rest of the backup-attestation system — closing
 * this card without acting reopens it next launch until the user backs up or
 * imports (see `useWallet`/`backupAttestation`).
 */
import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
  runOnJS
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, spacing, radii, typography, springs, durations, i18n } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set, one of which
 * reaches expo-font -> expo-asset -- untransformed ESM Jest cannot parse
 * when eagerly pulled in via the `ui` package barrel. Loaded lazily, same
 * pattern as this package's other native-module-boundary fixes.
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

export const BackupReminderSheet: React.FC<{
  visible: boolean
  onClose: () => void
  onBackupNow: () => void
}> = ({ visible, onClose, onBackupNow }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const reducedMotion = useReducedMotion()
  const insets = useSafeAreaInsets()

  // Rendered independently of `visible` so the exit slide-down can finish
  // before the card unmounts (mirrors Sheet's rendered/wasVisible pattern).
  const [rendered, setRendered] = useState(visible)
  const progress = useSharedValue(visible ? 1 : 0)

  useEffect(() => {
    if (visible) {
      setRendered(true)
      progress.value = reducedMotion ? withTiming(1, { duration: durations.instant }) : withSpring(1, springs.snappy)
    } else if (rendered) {
      progress.value = withTiming(0, { duration: durations.instant }, finished => {
        if (finished) runOnJS(setRendered)(false)
      })
    }
  }, [visible, progress, reducedMotion]) // eslint-disable-line react-hooks/exhaustive-deps

  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 40 }, { scale: 0.96 + 0.04 * progress.value }]
  }))

  if (!rendered) return null

  return (
    // box-none: this wrapper (and the empty space around the card) never
    // intercepts touches, so the screen behind stays fully interactive.
    <View style={[styles.wrapper, { paddingBottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: colors.sheetBackground, borderColor: colors.warning },
          cardStyle
        ]}
      >
        <PressableScale haptic="tap" onPress={onClose} style={styles.closeButton}>
          <Ionicons name="close" size={20} color={colors.textSecondary} />
        </PressableScale>

        <View style={styles.body}>
          <View style={[styles.heroIcon, { backgroundColor: colors.warning + '22' }]}>
            <Ionicons name="warning-outline" size={28} color={colors.warning} />
          </View>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('backup_reminder_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('backup_reminder_body')}</Text>

          <PressableScale
            haptic="confirm"
            onPress={onBackupNow}
            style={[styles.primary, { backgroundColor: colors.warning }]}
          >
            <Ionicons name="key-outline" size={20} color={colors.textOnAccent} style={styles.btnIcon} />
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('backup_reminder_now')}</Text>
          </PressableScale>
        </View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
    alignItems: 'center',
    paddingHorizontal: spacing.lg
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radii.xl,
    borderWidth: 2,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 12
  },
  closeButton: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    zIndex: 1,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: { padding: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  h1: { ...typography.headline, textAlign: 'center' },
  p: { ...typography.footnote, textAlign: 'center', marginBottom: spacing.xs },
  primary: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  primaryLabel: { ...typography.subhead, fontWeight: '600' },
  btnIcon: { marginRight: spacing.sm }
})
