/**
 * The Safari setup guide (spec 6.12): a card the host places in onboarding and in Settings. The app
 * cannot see the extension or its site access, so this is text, not a gate, and there is no button
 * (iOS has no link into Safari's extension settings).
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { radii, spacing, typography } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'

export function SafariSetupGuide(): React.ReactElement {
  const { t } = useTranslation()
  const { colors } = useTheme()
  return (
    <View testID="bridge-setup-guide" style={[styles.card, { backgroundColor: colors.backgroundSecondary }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('bridge_setup_title')}</Text>
      <Text style={[styles.step, { color: colors.textPrimary }]}>{`1. ${t('bridge_setup_step_extension')}`}</Text>
      <Text style={[styles.step, { color: colors.textPrimary }]}>{`2. ${t('bridge_setup_step_allow')}`}</Text>
      <Text style={[styles.why, { color: colors.textSecondary }]}>{t('bridge_setup_why')}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, borderRadius: radii.lg, gap: spacing.sm },
  title: { ...typography.headline },
  step: { ...typography.body },
  why: { ...typography.callout }
})
