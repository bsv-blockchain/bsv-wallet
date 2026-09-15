/**
 * "You can't be paid in USDX yet" — the screen that replaces a payment code
 * rather than showing one that cannot work.
 *
 * Showing the QR anyway would manufacture a failure inside someone else's app,
 * attributed to nothing: the payer scans, their wallet refuses, and neither
 * party can see why. Withholding the code and naming the party who decides is
 * the whole of error prevention in one screen.
 *
 * It deliberately offers no "How to get registered" affordance. There is no
 * route inside this wallet to become registered — registration is the issuer's
 * chain, gated by whatever the issuer requires — so a button for it would
 * dead-end. What it offers instead is the rail that works right now.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { hitTargets, radii, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

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

export interface AdmissionNoticeProps {
  ticker: string
  /** Resolved issuer name; falls back to "the issuer" rather than a hex key. */
  issuerName?: string
  /**
   * The runtime's own plain reason, when it has one. It wins over the generic
   * body: a specific true sentence beats a general true sentence.
   */
  reason?: string | null
  onBsvInstead: () => void
}

export default function AdmissionNotice({ ticker, issuerName, reason, onBsvInstead }: AdmissionNoticeProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const issuer = issuerName || t('token_issuer_fallback')

  return (
    // One region, so the title and the reason are read together before the
    // route row rather than as three unrelated announcements.
    <View style={styles.wrap} accessibilityRole="summary" accessible>
      <Ionicons name="alert-circle-outline" size={48} color={colors.textTertiary} />
      <Text style={[styles.title, { color: colors.textPrimary }]} textBreakStrategy="balanced">
        {t('token_admit_title', { ticker })}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary }]} textBreakStrategy="balanced">
        {reason || t('token_admit_body', { issuer, ticker })}
      </Text>
      <PressableScale
        onPress={onBsvInstead}
        haptic="tap"
        style={[styles.route, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
        accessibilityRole="button"
        accessibilityLabel={t('token_admit_bsv_instead')}
      >
        <Ionicons name="arrow-down" size={18} color={colors.textPrimary} />
        <Text style={[styles.routeLabel, { color: colors.textPrimary }]}>{t('token_admit_bsv_instead')}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, gap: spacing.md },
  title: { ...typography.title3, textAlign: 'center' },
  body: { ...typography.subhead, textAlign: 'center', maxWidth: 320 },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'stretch',
    minHeight: hitTargets.minimum,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md
  },
  routeLabel: { ...typography.headline, fontWeight: '600', flex: 1 }
})
