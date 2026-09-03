/**
 * Shown only before any wallet exists on this device (a true fresh install,
 * prior to the first Pay/Get Paid tap that lazily creates one — see
 * WalletHomeScreen's destinationPress/ensureWalletExists). Gives a returning
 * user with an existing recovery key a way in without first tripping the
 * biometric-advisory/auto-create path meant for brand-new wallets.
 *
 * Sticky at the bottom of the screen, and non-blocking like
 * BackupReminderSheet: no backdrop, no Modal, the rest of the screen
 * (including Pay/Get Paid) stays interactive underneath it
 * (pointerEvents="box-none" on the wrapper).
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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

export const ImportFromBackupPrompt: React.FC<{
  visible: boolean
  onImport: () => void
}> = ({ visible, onImport }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const insets = useSafeAreaInsets()

  if (!visible) return null

  return (
    <View style={[styles.wrapper, { paddingBottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
      <View style={[styles.card, { backgroundColor: colors.sheetBackground, borderColor: colors.separator }]}>
        <Ionicons name="download-outline" size={22} color={colors.accent} style={styles.icon} />
        <View style={styles.textGroup}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('import_prompt_title')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('import_prompt_body')}</Text>
        </View>
        <PressableScale haptic="tap" onPress={onImport} style={[styles.button, { borderColor: colors.accent }]}>
          <Text style={[styles.buttonLabel, { color: colors.accent }]}>{t('import_prompt_action')}</Text>
        </PressableScale>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    alignItems: 'center',
    paddingHorizontal: spacing.lg
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6
  },
  icon: { marginBottom: spacing.xs },
  textGroup: { alignItems: 'center', gap: 2 },
  title: { ...typography.subhead, fontWeight: '600', textAlign: 'center' },
  body: { ...typography.footnote, textAlign: 'center' },
  button: {
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  buttonLabel: { ...typography.subhead, fontWeight: '600' }
})
