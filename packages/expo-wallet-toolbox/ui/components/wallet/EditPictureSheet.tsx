/**
 * "Edit picture" — the stacked pill buttons that choose where an avatar comes
 * from.
 *
 * Today that is one source: a picked icon. Take Photo and Photo Library are
 * deliberately ABSENT rather than present-and-inert — they need
 * `expo-image-picker`, a native dependency this build does not carry, and a
 * button that does nothing when tapped is worse than a button that is not
 * there (the same reasoning that kept a dead "Add photo" control off this
 * screen originally). Add the two entries here once the dependency lands.
 */
import React from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'
import { durations, easings, radii, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

export interface EditPictureOption {
  key: string
  label: string
  onPress: () => void
}

export default function EditPictureSheet({
  visible,
  options,
  onClose
}: {
  visible: boolean
  options: EditPictureOption[]
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const reduced = useReducedMotion()
  const progress = useSharedValue(0)

  React.useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: visible ? durations.quick : durations.instant,
      easing: easings.out
    })
  }, [visible, progress])

  const cardStyle = useAnimatedStyle(() =>
    reduced
      ? { opacity: progress.value, transform: [{ translateY: 0 }] }
      : { opacity: progress.value, transform: [{ translateY: (1 - progress.value) * 24 }] }
  )
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }))

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={onClose} />
        </Animated.View>
        <Animated.View style={[styles.wrap, cardStyle]} pointerEvents="box-none">
          <View style={[styles.card, { backgroundColor: colors.sheetBackground }]}>
            {options.map(opt => (
              <PressableScale
                key={opt.key}
                haptic="tap"
                onPress={() => {
                  onClose()
                  opt.onPress()
                }}
                accessibilityRole="button"
                style={[styles.pill, { backgroundColor: colors.fillTertiary }]}
              >
                <Text style={[styles.pillLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
              </PressableScale>
            ))}
          </View>
          <PressableScale
            haptic="tap"
            onPress={onClose}
            accessibilityRole="button"
            style={[styles.cancel, { backgroundColor: colors.sheetBackground }]}
          >
            <Text style={[styles.pillLabel, styles.cancelLabel, { color: colors.accent }]}>
              {t('cancel', { defaultValue: 'Cancel' })}
            </Text>
          </PressableScale>
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: spacing.md, paddingBottom: spacing.xxxl },
  card: { borderRadius: radii.xl, padding: spacing.sm, gap: spacing.sm },
  pill: { borderRadius: radii.lg, paddingVertical: spacing.lg, alignItems: 'center' },
  pillLabel: { ...typography.title3, fontWeight: '600' },
  cancel: { borderRadius: radii.xl, paddingVertical: spacing.lg, alignItems: 'center', marginTop: spacing.sm },
  cancelLabel: { fontWeight: '700' }
})
