/**
 * The "IDENTIFIER" row of a grouped card: the key abbreviated in monospace
 * with a copy button on the right. Shared by Contact, New Contact and
 * Profile so the same key reads the same way on all three.
 */
import React, { useCallback } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'
import { showToast } from '../ui/Toast'
import { abbreviateKey } from '../../../core/pay/counterparty'

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
 * Loaded lazily for the same reason every native module in this package is:
 * the `ui` barrel must stay parseable under Jest, which cannot load the
 * clipboard module's native binding.
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

export default function IdentifierRow({ identityKey }: { identityKey: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const onCopy = useCallback(() => {
    loadClipboard().setString(identityKey)
    showToast(t('copied'), { type: 'success' })
  }, [identityKey, t])
  return (
    <View style={styles.row}>
      <Text style={[styles.key, { color: colors.textPrimary }]} numberOfLines={1} ellipsizeMode="middle">
        {abbreviateKey(identityKey)}
      </Text>
      <PressableScale
        onPress={onCopy}
        haptic="tap"
        style={styles.copyBtn}
        accessibilityRole="button"
        accessibilityLabel={t('contact_copy_identifier')}
      >
        <Ionicons name="copy-outline" size={18} color={colors.textSecondary} />
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingLeft: spacing.lg, paddingRight: spacing.xs },
  key: { ...typography.subhead, fontFamily: 'monospace', flex: 1 },
  copyBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }
})
