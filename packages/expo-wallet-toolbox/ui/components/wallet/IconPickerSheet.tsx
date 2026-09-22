/**
 * Pick an avatar icon — a bottom sheet with a scrollable, grouped grid.
 *
 * Grouped with a heading per section rather than one long grid: 67 glyphs in
 * an undifferentiated wall is a search problem, and the headings turn it into
 * "go to Animals". Same shape as the workspace-icon picker this was modelled
 * on.
 *
 * Six columns, sized from the viewport rather than fixed, so the tiles stay
 * square and tappable from the narrowest phone up.
 */
import React from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'
import {
  durations,
  easings,
  radii,
  spacing,
  typography,
  useTheme,
  useUserAvatarIcon,
  setUserAvatarIcon,
  type AvatarIcon
} from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'
import { AvatarGlyph } from './UserAvatar'
import { AVATAR_ICON_GROUPS } from './avatarIcons'

const COLUMNS = 6

export default function IconPickerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { width, height } = useWindowDimensions()
  const reduced = useReducedMotion()
  const chosen = useUserAvatarIcon()
  const progress = useSharedValue(0)

  React.useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: visible ? durations.moderate : durations.quick,
      easing: easings.out
    })
  }, [visible, progress])

  // Rises from the bottom edge; reduced motion crossfades in place instead.
  const sheetStyle = useAnimatedStyle(() =>
    reduced
      ? { opacity: progress.value, transform: [{ translateY: 0 }] }
      : { opacity: 1, transform: [{ translateY: (1 - progress.value) * height }] }
  )
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }))

  const tile = Math.floor((width - spacing.lg * 2 - spacing.sm * (COLUMNS - 1)) / COLUMNS)

  const pick = (icon: AvatarIcon) => {
    setUserAvatarIcon(icon)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: colors.sheetBackground, maxHeight: height * 0.75 },
            sheetStyle
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.separator }]} />
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {t('avatar_pick_icon', { defaultValue: 'Pick icon' })}
          </Text>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {AVATAR_ICON_GROUPS.map(group => (
              <View key={group.labelKey} style={styles.group}>
                <Text style={[styles.groupLabel, { color: colors.textTertiary }]}>
                  {t(group.labelKey, { defaultValue: group.labelFallback })}
                </Text>
                <View style={styles.grid}>
                  {group.icons.map(opt => {
                    const selected = chosen?.family === opt.family && chosen?.name === opt.name
                    return (
                      <PressableScale
                        key={`${opt.family}/${opt.name}`}
                        haptic="tap"
                        onPress={() => pick(opt)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={opt.name}
                        style={[
                          styles.tile,
                          {
                            width: tile,
                            height: tile,
                            borderRadius: radii.md,
                            backgroundColor: selected ? colors.accent : colors.fillTertiary,
                            borderColor: selected ? colors.accent : colors.separator
                          }
                        ]}
                      >
                        <AvatarGlyph
                          family={opt.family}
                          name={opt.name}
                          size={Math.round(tile * 0.55)}
                          color={selected ? colors.textOnAccent : colors.textPrimary}
                        />
                      </PressableScale>
                    )
                  })}
                </View>
              </View>
            ))}
            {/* Back to the plain disc — an avatar has to be removable, or the
                first pick is permanent. */}
            {chosen ? (
              <PressableScale
                haptic="tap"
                onPress={() => {
                  setUserAvatarIcon(null)
                  onClose()
                }}
                style={[styles.clear, { borderColor: colors.separator }]}
              >
                <Text style={[styles.clearLabel, { color: colors.error }]}>
                  {t('avatar_remove', { defaultValue: 'Remove picture' })}
                </Text>
              </PressableScale>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingBottom: spacing.xxxl
  },
  grabber: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: spacing.sm },
  title: { ...typography.headline, textAlign: 'center', marginTop: spacing.md, marginBottom: spacing.sm },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  group: { marginTop: spacing.lg },
  groupLabel: { ...typography.caption1, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  clear: {
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center'
  },
  clearLabel: { ...typography.body, fontWeight: '600' }
})
