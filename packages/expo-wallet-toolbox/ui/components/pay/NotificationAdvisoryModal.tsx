/**
 * One-time heads-up shown the first time the user picks "Share remote link" on
 * "Get paid", before the OS asks to allow notifications. Same rationale as
 * NearbyAdvisoryModal and BiometricAdvisoryModal: never let an OS permission
 * dialog be the user's first signal that something is about to happen — say
 * what it is for, briefly, first.
 *
 * The OS prompt is fired only on Continue. Either button records that the
 * advisory was shown, and neither blocks the link flow underneath.
 */
import React from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing, radii, typography, i18n } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

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
 * Whether the advisory should be on screen. Pure so the gating is testable
 * without rendering the screen: only on the remote-link method, only once per
 * device, and only while the OS would still ask (granted/denied are final, and
 * `null` means the state has not loaded yet — show nothing rather than flash).
 */
export function shouldShowNotificationAdvisory(s: {
  method: string | null
  advisorySeen: boolean | null
  permission: 'granted' | 'denied' | 'undetermined' | null
}): boolean {
  return s.method === 'get-handle' && s.advisorySeen === false && s.permission === 'undetermined'
}

export const NotificationAdvisoryModal: React.FC<{
  visible: boolean
  onNotNow: () => void
  onContinue: () => void
}> = ({ visible, onNotNow, onContinue }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  if (!visible) return null

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={onNotNow}
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
    >
      <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onNotNow}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="Dismisses this advisory"
        />
        <View style={[styles.card, { backgroundColor: colors.sheetBackground, borderColor: colors.separator }]}>
          <View style={[styles.heroIcon, { backgroundColor: colors.fillTertiary }]}>
            <Ionicons name="notifications-outline" size={26} color={colors.accent} />
          </View>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('push_advisory_title')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('push_advisory_body')}</Text>

          <PressableScale
            haptic="confirm"
            onPress={onContinue}
            style={[styles.primary, { backgroundColor: colors.accent }]}
          >
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('push_advisory_continue')}</Text>
          </PressableScale>

          <PressableScale haptic="tap" onPress={onNotNow} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('push_advisory_not_now')}</Text>
          </PressableScale>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.md
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  title: { ...typography.title2, textAlign: 'center' },
  body: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.sm },
  primary: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
