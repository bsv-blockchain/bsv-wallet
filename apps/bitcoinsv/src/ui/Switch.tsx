// The prototype's switch (components/ui/switch.tsx, shadcn's): 32 × 18.4,
// primary when on and the input grey when off, its 16 pt thumb in the
// background colour sliding across. Track and thumb both ease over Tailwind's
// 150ms cubic-bezier(0.4, 0, 0.2, 1) (transition-all / transition-transform).
import React, { useEffect } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import Animated, { Easing, interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useIsDark, usePalette } from '../theme'
import { useReducedMotion } from './motion'

const EASE = Easing.bezier(0.4, 0, 0.2, 1)

export function Switch({ value, onValueChange, label }: { value: boolean; onValueChange: (v: boolean) => void; label: string }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const x = useSharedValue(value ? 1 : 0)
  useEffect(() => {
    x.value = withTiming(value ? 1 : 0, { duration: still ? 0 : 150, easing: EASE })
  }, [value, x, still])
  const off = palette.input
  const on = palette.primary
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(x.value, [0, 1], [off, on]) }))
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 14 }] }))
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
    >
      <Animated.View style={[styles.track, track]}>
        <Animated.View
          style={[
            styles.thumb,
            { backgroundColor: dark ? (value ? palette.primaryForeground : palette.foreground) : palette.background },
            thumb
          ]}
        />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  track: { width: 32, height: 18.4, borderRadius: 999, padding: 1.2, justifyContent: 'center' },
  thumb: { width: 16, height: 16, borderRadius: 8 }
})
