/**
 * One-time consent gate shown the first time the user taps Pay or Get Paid
 * with no wallet yet created. Apple HIG: never surface a Face ID/Touch ID
 * prompt before the user has done something that explains why it's
 * happening. Wallet creation needs biometric-gated storage, so instead of
 * building the wallet eagerly on first launch (which put a biometric prompt
 * in front of a user who hadn't tapped anything), creation is deferred to
 * this moment and this modal explains the prompt before it fires.
 *
 * Blocking by design (unlike the non-blocking BackupReminderSheet): this is
 * a single explicit decision point, not a recurring nag, and the user is
 * already mid-action (about to pay or receive) so a brief pause here reads
 * as consent, not interruption.
 */
import React from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing, radii, typography, i18n } from '@bsv/expo-wallet-toolbox'
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

export const BiometricAdvisoryModal: React.FC<{
  visible: boolean
  /** Wallet creation (mnemonic generation + biometric-gated storage write) is
   * running. The PBKDF2/BIP32 math alone is real, blocking JS-thread work —
   * dismissing the modal the instant Continue is tapped left the screen
   * looking frozen for that whole stretch, with nothing on screen explaining
   * why. Keeping the modal up with a spinner in place of the label instead. */
  loading?: boolean
  onCancel: () => void
  onContinue: () => void
}> = ({ visible, loading = false, onCancel, onContinue }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  if (!visible) return null

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={loading ? undefined : onCancel}
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
    >
      <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={loading ? undefined : onCancel}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="Dismisses this advisory"
        />
        <View style={[styles.card, { backgroundColor: colors.sheetBackground, borderColor: colors.separator }]}>
          <View style={[styles.heroIcon, { backgroundColor: colors.fillTertiary }]}>
            <Ionicons name="finger-print" size={28} color={colors.accent} />
          </View>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('biometric_advisory_title')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('biometric_advisory_body')}</Text>

          <PressableScale
            haptic="confirm"
            onPress={loading ? undefined : onContinue}
            disabled={loading}
            style={[styles.primary, { backgroundColor: colors.accent, opacity: loading ? 0.7 : 1 }]}
          >
            {loading ? (
              <ActivityIndicator color={colors.textOnAccent} />
            ) : (
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('continue')}</Text>
            )}
          </PressableScale>

          <PressableScale haptic="tap" onPress={loading ? undefined : onCancel} disabled={loading} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: loading ? colors.textTertiary : colors.textSecondary }]}>
              {t('cancel')}
            </Text>
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
