/**
 * The bottom sheet shown on a freshly auto-created wallet (balance zero,
 * empty activity), prompting the user to secure their keys before the
 * screen fills up with real money and history.
 *
 * Advisory only, same as the rest of the backup-attestation system — closing
 * this sheet without acting reopens it next launch until the user backs up
 * or imports (see `useWallet`/`backupAttestation`).
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTheme, spacing, radii, typography, i18n } from '@bsv/expo-wallet-toolbox'
import Sheet from '../ui/Sheet'
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
  onImportFromBackup: () => void
}> = ({ visible, onClose, onBackupNow, onImportFromBackup }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  return (
    <Sheet visible={visible} onClose={onClose} fitContent>
      <View style={styles.body}>
        <View style={[styles.heroIcon, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons name="shield-checkmark-outline" size={28} color={colors.accent} />
        </View>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('backup_reminder_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('backup_reminder_body')}</Text>

        <PressableScale
          haptic="confirm"
          onPress={onBackupNow}
          style={[styles.primary, { backgroundColor: colors.accent }]}
        >
          <Ionicons name="key-outline" size={20} color={colors.textOnAccent} style={styles.btnIcon} />
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('backup_reminder_now')}</Text>
        </PressableScale>

        <PressableScale
          haptic="tap"
          onPress={onImportFromBackup}
          style={[styles.secondary, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
        >
          <Ionicons name="download-outline" size={20} color={colors.accent} style={styles.btnIcon} />
          <Text style={[styles.secondaryLabel, { color: colors.textPrimary }]}>{t('backup_reminder_import')}</Text>
        </PressableScale>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, paddingTop: spacing.lg, gap: spacing.md, alignItems: 'center' },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.sm },
  primary: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  primaryLabel: { ...typography.headline },
  secondary: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  secondaryLabel: { ...typography.headline },
  btnIcon: { marginRight: spacing.sm }
})
