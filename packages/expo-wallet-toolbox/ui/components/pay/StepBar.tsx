/**
 * The thin progress bar across the top of Pay's three steps (who / amount /
 * review). No "Step n of 3" caption (2026-09-18 design ruling) — just the
 * track. Same visual weight as `EnrollWizard`'s `StepProgress`, which this is
 * lifted from, minus the label.
 */
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme, radii, spacing } from '@bsv/expo-wallet-toolbox'

export type PayStep = 'who' | 'amount' | 'review'

const STEPS: PayStep[] = ['who', 'amount', 'review']

export default function StepBar({ step }: { step: PayStep }) {
  const { colors } = useTheme()
  const n = STEPS.indexOf(step) + 1
  const total = STEPS.length
  return (
    <View
      style={styles.wrap}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: total, now: n }}
    >
      <View style={[styles.track, { backgroundColor: colors.backgroundSecondary }]}>
        <View style={[styles.fill, { backgroundColor: colors.accent, width: `${(n / total) * 100}%` }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
  track: { height: 4, borderRadius: radii.sm, overflow: 'hidden' },
  fill: { height: 4, borderRadius: radii.sm }
})
