/**
 * One-time heads-up shown the first time the user opens a nearby pay/get-paid
 * cell, before the OS-level prompts that flow triggers (iOS Local Network
 * access; Android Bluetooth/nearby-Wi-Fi permissions). Same rationale as
 * BiometricAdvisoryModal: never let an OS permission dialog be the user's
 * first signal that something is happening — explain it, briefly, first.
 *
 * The reassurance matters more than the mechanics here: this looks like the
 * kind of permission that builds a tracking profile, and it is the opposite —
 * strictly local, device-to-device, nothing sent to any server.
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

export const NearbyAdvisoryModal: React.FC<{
  visible: boolean
  onCancel: () => void
  onContinue: () => void
}> = ({ visible, onCancel, onContinue }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  if (!visible) return null

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
    >
      <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="Dismisses this advisory"
        />
        <View style={[styles.card, { backgroundColor: colors.sheetBackground, borderColor: colors.separator }]}>
          <View style={[styles.heroIcon, { backgroundColor: colors.fillTertiary }]}>
            <Ionicons name="wifi" size={26} color={colors.accent} />
          </View>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('nearby_advisory_title')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('nearby_advisory_body')}</Text>

          <PressableScale
            haptic="confirm"
            onPress={onContinue}
            style={[styles.primary, { backgroundColor: colors.accent }]}
          >
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('continue')}</Text>
          </PressableScale>

          <PressableScale haptic="tap" onPress={onCancel} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
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
