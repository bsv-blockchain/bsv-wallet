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

  if (!visible) return null

  return (
    <View style={[styles.wrapper, { paddingBottom: CARD_INSET }]} pointerEvents="box-none">
      <View style={[styles.card, { backgroundColor: colors.sheetBackground, borderColor: colors.separator }]}>
        <View style={[styles.iconCircle, { backgroundColor: colors.fill }]}>
          <Ionicons name="download-outline" size={22} color={colors.accent} />
        </View>
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

/**
 * The card hugs the bottom of the screen, so its corners have to agree with the
 * screen's own. Concentric rounding means the inner radius is the outer one
 * less the gap between them — anything else and the two curves visibly fight.
 *
 * The display corner is a constant because no RN API reports it. 55pt is the
 * modern iPhone notch-era radius; on a device that differs (an iPad, most
 * Android hardware) the card is merely a little rounder or flatter than its
 * housing, which is a far smaller error than not following it at all.
 */
const SCREEN_CORNER = 55
const CARD_INSET = spacing.lg

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    alignItems: 'center',
    paddingHorizontal: CARD_INSET
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: SCREEN_CORNER - CARD_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  textGroup: { alignItems: 'center', gap: spacing.xs },
  title: { ...typography.subhead, fontWeight: '600', textAlign: 'center' },
  body: { ...typography.footnote, textAlign: 'center' },
  button: {
    // Set apart from the copy it acts on, and given enough height that a pill
    // border reads as a control rather than as a caption in a box.
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  buttonLabel: { ...typography.subhead, fontWeight: '600' }
})
