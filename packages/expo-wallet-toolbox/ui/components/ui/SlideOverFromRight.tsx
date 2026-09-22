/**
 * A full-screen surface that arrives from the right and leaves to the right —
 * the push/pop a native stack gives you, for a view presented inside a screen
 * rather than routed to.
 *
 * React Native's `Modal` animates only vertically (`animationType="slide"`
 * comes up from the bottom), which reads as a sheet, not a push. So the
 * transform is ours, and per the motion rules it runs on the UI thread via
 * Reanimated and decelerates on `easings.out` — never a JS timer.
 *
 * Reduced motion collapses the translation to a crossfade rather than removing
 * the transition: the surface still needs to read as arriving.
 */
import React, { useEffect, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { durations, easings } from '@bsv/expo-wallet-toolbox'

export default function SlideOverFromRight({
  visible,
  onClosed,
  children
}: {
  visible: boolean
  /** Fired once the surface has finished leaving, so the caller can drop its content. */
  onClosed?: () => void
  children: React.ReactNode
}) {
  const { width } = useWindowDimensions()
  const reduced = useReducedMotion()
  // Mounted for as long as anything is on screen — through the close animation,
  // not just while `visible` is true.
  const [mounted, setMounted] = useState(visible)
  const progress = useSharedValue(visible ? 1 : 0)

  // Adjusting own state during render, which React sanctions for "derive from
  // a prop that just changed" — an effect would mount one frame late and the
  // surface would jump in already half-arrived.
  if (visible && !mounted) setMounted(true)

  useEffect(() => {
    const done = (finished?: boolean) => {
      'worklet'
      if (finished && !visible) {
        runOnJS(setMounted)(false)
        if (onClosed) runOnJS(onClosed)()
      }
    }
    progress.value = withTiming(
      visible ? 1 : 0,
      { duration: visible ? durations.moderate : durations.quick, easing: easings.out },
      done
    )
    // `onClosed` is deliberately absent: an inline callback from the caller
    // would re-run this effect on every render and restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, progress])

  const style = useAnimatedStyle(() =>
    reduced
      ? { opacity: progress.value, transform: [{ translateX: 0 }] }
      : { opacity: 1, transform: [{ translateX: (1 - progress.value) * width }] }
  )

  if (!mounted) return null

  return (
    <View style={[StyleSheet.absoluteFill, styles.above]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  // A full-screen surface has to cover the screen it arrives over, including
  // that screen's own lifted chrome. The list's top ScrollFade carries
  // zIndex 1, and being a later sibling is not enough to beat it — without
  // this the fade's 24pt band paints straight across the arriving surface.
  above: { zIndex: 10 }
})
