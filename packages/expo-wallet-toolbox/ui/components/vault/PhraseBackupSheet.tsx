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
      <Text style={[styles.p, { color: colors.textSecondary }]}>
        {t('vault_phrase_intro', { count: words.length })}
      </Text>

      {/* Two fixed columns with the index in its own right-aligned gutter, so
          every word starts on the same x. The old grid let each cell size to
          its own content, which put the words on a ragged left edge and made a
          list you have to hunt through rather than one you can read down.
          Inverted (warning-tinted fill, high-contrast text) rather than the
          page's ordinary card styling — this is the one block of content the
          user actually has to act on (copy to paper), so it needs to read as
          distinct from the surrounding chrome, not blend into it. */}
      <View style={[styles.grid, { backgroundColor: colors.warning, borderColor: colors.warning }]}>
        {words.map((word, i) => (
          <View key={i} style={styles.wordCell}>
            <Text style={[styles.wordIndex, { color: colors.textOnAccent, opacity: 0.6 }]}>{i + 1}</Text>
            <Text style={[styles.word, { color: colors.textOnAccent }]}>{word}</Text>
          </View>
        ))}
      </View>

      {/* Copy is deliberately the quietest control on the screen. The screen is
          asking for pen and paper; a full-width button offering the clipboard
          instead argues against its own instruction. */}
      <PressableScale
        onPress={() => {
          loadClipboard().setString(mnemonic)
          showToast(t('vault_phrase_copied'), { type: 'success' })
        }}
        style={styles.copyRow}
      >
        <Ionicons name="copy-outline" size={15} color={colors.textSecondary} />
        <Text style={[styles.copyLabel, { color: colors.textSecondary }]}>{t('vault_phrase_copy')}</Text>
      </PressableScale>

      {/* Tinted rather than outlined: the border box read as an error state on
          a screen where nothing has gone wrong. */}
      <View style={[styles.warnBox, { backgroundColor: colors.warning + '14' }]}>
        <Ionicons name="warning-outline" size={16} color={colors.warning} />
        <Text style={[styles.warnText, { color: colors.textSecondary }]}>
          {t('vault_phrase_warning')}
        </Text>
      </View>

      <PressableScale
        onPress={() => setAcknowledged(a => !a)}
        style={[
          styles.checkRow,
          {
            // colors.fill, not `colors.accent + '14'`: accent is the NAMED colour
            // 'white' (dark) / 'black' (light), so appending hex alpha produced
            // "white14" and Reanimated threw on the animated style. fill is the
            // theme's own translucent overlay and is valid in both themes.
            backgroundColor: acknowledged ? colors.fill : colors.backgroundSecondary,
            borderColor: acknowledged ? colors.accent : colors.separator
          }
        ]}
      >
        <Ionicons
          name={acknowledged ? 'checkmark-circle' : 'ellipse-outline'}
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
          // Outlined until the box is ticked, matching the enrolment gate: a
          // disabled fill in the secondary background is invisible in dark mode.
          {
            backgroundColor: acknowledged ? colors.accent : 'transparent',
            borderWidth: acknowledged ? 0 : StyleSheet.hairlineWidth,
            borderColor: colors.separator
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
  p: { ...typography.subhead, textAlign: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md
  },
  wordCell: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  // Fixed gutter, right-aligned: 1 and 12 then occupy the same width and the
  // words line up in two clean columns.
  wordIndex: { ...typography.caption2, width: 20, textAlign: 'right' },
  word: { ...typography.body, fontWeight: '600' },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm
  },
  copyLabel: { ...typography.footnote },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radii.md,
    padding: spacing.md
  },
  warnText: { ...typography.footnote, flex: 1 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  checkLabel: { ...typography.subhead, flex: 1 },
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
