/**
 * The bridge toast (spec 6.12): a short banner for a bounce that needed no approval ("Done · ◀ Safari")
 * or that did not complete ("Not completed · ◀ Safari"). It hides itself after `TOAST_MS`.
 */
import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { radii, spacing, typography } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'

export const TOAST_MS = 2500

export interface ToastProps {
  /** Null hides the toast. `ok` false shows the failed copy. */
  toast: { ok: boolean; id: number } | null
  onHide(): void
}

export function Toast({ toast, onHide }: ToastProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const id = toast?.id
  useEffect(() => {
    if (id === undefined) return
    const timer = setTimeout(onHide, TOAST_MS)
    return () => clearTimeout(timer)
    // A new toast restarts the clock; onHide is a stable setter in the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  if (toast === null) return null
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={[styles.banner, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
        <Text testID="bridge-toast" style={[styles.text, { color: colors.textPrimary }]}>
          {toast.ok ? t('bridge_toast_done') : t('bridge_toast_failed')}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
    zIndex: 1100
  },
  banner: {
    marginTop: 64,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: { ...typography.headline }
})
