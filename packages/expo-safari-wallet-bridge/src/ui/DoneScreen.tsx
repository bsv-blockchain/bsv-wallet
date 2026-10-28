/**
 * The done screen (spec 6.12): shown over the app after a call that needed the user's approval was
 * answered. It is dismissed by a tap or by the app leaving the foreground; it has no timer and no button,
 * because the user may take as long as they like before going back to Safari.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { radii, spacing, typography } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
import { aggregate, type DoneModel, type Receipt } from '../receipts'

type T = (key: string, params?: Record<string, unknown>) => string

/** The summary line for a model, in the user's language. */
export function summaryText(t: T, summary: NonNullable<DoneModel['summary']>): string {
  switch (summary.kind) {
    case 'payment':
      return t('bridge_done_payment', { amount: summary.amount })
    case 'action':
      return t('bridge_done_action')
    case 'signed':
      return t('bridge_done_signed')
    case 'encrypted':
      return t('bridge_done_encrypted')
    case 'certificate':
      return t('bridge_done_certificate')
    case 'requests':
      return t('bridge_done_n_requests', { n: summary.n })
    default:
      return t('bridge_done_approved')
  }
}

export interface DoneScreenProps {
  /** The receipts since the screen was last dismissed; only the ones that were approved and needed approval count. */
  receipts: Receipt[]
  /** The app is in the foreground. */
  active: boolean
  /** A permission sheet is open or queued (`usePermissionSheetBusy()`); a later sheet replaces the screen. */
  busy: boolean
  onDismiss(): void
}

export function DoneScreen({ receipts, active, busy, onDismiss }: DoneScreenProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const shown = receipts.filter(r => r.ok && r.neededApproval)
  if (shown.length === 0 || !active || busy) return null
  const model = aggregate(shown)
  const headline =
    model.sites !== undefined
      ? t('bridge_done_n_sites', { n: model.sites })
      : t('bridge_done_sent_to', { site: model.site })
  return (
    <Pressable
      testID="bridge-done-screen"
      accessibilityRole="button"
      accessibilityLabel={headline}
      onPress={onDismiss}
      style={[styles.overlay, { backgroundColor: colors.background }]}
    >
      <View style={styles.body}>
        <Text style={[styles.check, { color: colors.success }]}>{'✓'}</Text>
        <Text style={[styles.headline, { color: colors.textPrimary }]}>{headline}</Text>
        {model.summary !== undefined && (
          <Text style={[styles.summary, { color: colors.textSecondary }]}>{summaryText(t, model.summary)}</Text>
        )}
        <Text style={[styles.hint, { color: colors.textSecondary, backgroundColor: colors.backgroundSecondary }]}>
          {t('bridge_done_back_hint')}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000
  },
  body: { alignItems: 'center', paddingHorizontal: spacing.xxl, gap: spacing.md },
  check: { fontSize: 64, lineHeight: 72, fontWeight: '700' },
  headline: { ...typography.title2, textAlign: 'center' },
  summary: { ...typography.body, textAlign: 'center' },
  hint: {
    ...typography.callout,
    textAlign: 'center',
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    overflow: 'hidden'
  }
})
