/**
 * Reveals the recovery phrase and takes the user's word that they wrote it
 * down.
 *
 * No verification quiz by design: the person needs to be held accountable, but
 * verification should not be painful. The confirm is an attestation, and the
 * caller records it as such.
 *
 * The caller is responsible for reading the mnemonic out of secure storage —
 * getMnemonic() is already behind the biometric latch, so this component never
 * touches storage and never holds the phrase beyond its own mount.
 */
import React, { useState } from 'react'
import { View, Text, StyleSheet, ScrollView } from 'react-native'
import { useTheme, spacing, radii, typography, i18n } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'
import { showToast } from '../ui/Toast'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

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

/**
 * @react-native-clipboard/clipboard reaches for its native TurboModule at
 * import time (`TurboModuleRegistry.getEnforcing`), which throws under Jest
 * (no native binary registered there) even though the module itself
 * transforms fine. Required lazily, only when a handler actually copies
 * something, so importing the `ui` barrel never touches the native module.
 * Same pattern as WalletHomeScreen.tsx's lazy clipboard load.
 */
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

export const PhraseBackupSheet: React.FC<{
  mnemonic: string
  onAttest: () => void
  onCancel: () => void
}> = ({ mnemonic, onAttest, onCancel }) => {
  const { colors } = useTheme()
  const [acknowledged, setAcknowledged] = useState(false)
  const words = mnemonic.trim().split(/\s+/)
  const Ionicons = loadIonicons()

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_phrase_title')}</Text>
      <Text style={[styles.p, { color: colors.textSecondary }]}>
        {t('vault_phrase_intro', { count: words.length })}
      </Text>

      <View style={[styles.grid, { borderColor: colors.separator }]}>
        {words.map((word, i) => (
          <View key={i} style={[styles.wordCell, { backgroundColor: colors.backgroundSecondary }]}>
            <Text style={[styles.wordIndex, { color: colors.textTertiary }]}>{i + 1}</Text>
            <Text style={[styles.word, { color: colors.textPrimary }]}>{word}</Text>
          </View>
        ))}
      </View>

      <PressableScale
        onPress={() => {
          loadClipboard().setString(mnemonic)
          showToast(t('vault_phrase_copied'), { type: 'success' })
        }}
        style={[styles.ghost, { borderColor: colors.separator }]}
      >
        <Ionicons name="copy-outline" size={16} color={colors.info} />
        <Text style={[styles.ghostLabel, { color: colors.info }]}>{t('vault_phrase_copy')}</Text>
      </PressableScale>

      <View style={[styles.warnBox, { borderColor: colors.warning }]}>
        <Ionicons name="warning-outline" size={16} color={colors.warning} />
        <Text style={[styles.warnText, { color: colors.textSecondary }]}>
          {t('vault_phrase_warning')}
        </Text>
      </View>

      <PressableScale onPress={() => setAcknowledged(a => !a)} style={styles.checkRow}>
        <Ionicons
          name={acknowledged ? 'checkbox' : 'square-outline'}
          size={22}
          color={acknowledged ? colors.accent : colors.textTertiary}
        />
        <Text style={[styles.checkLabel, { color: colors.textPrimary }]}>
          {t('vault_phrase_attest')}
        </Text>
      </PressableScale>

      <PressableScale
        haptic="confirm"
        onPress={acknowledged ? onAttest : undefined}
        style={[
          styles.primary,
          {
            backgroundColor: acknowledged ? colors.accent : colors.backgroundSecondary,
            opacity: acknowledged ? 1 : 0.6
          }
        ]}
      >
        <Text
          style={[
            styles.primaryLabel,
            { color: acknowledged ? colors.textOnAccent : colors.textTertiary }
          ]}
        >
          {t('vault_phrase_done')}
        </Text>
      </PressableScale>

      <PressableScale onPress={onCancel} style={styles.secondary}>
        <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
          {t('vault_back')}
        </Text>
      </PressableScale>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  wordCell: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: '30%'
  },
  wordIndex: { ...typography.caption2 },
  word: { ...typography.body, fontWeight: '600' },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md
  },
  ghostLabel: { ...typography.footnote, fontWeight: '600' },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  warnText: { ...typography.footnote, flex: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkLabel: { ...typography.footnote, flex: 1 },
  primary: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
