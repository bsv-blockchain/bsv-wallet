// A placeholder where something still loading will go (Tailwind's
// animate-pulse, as lazy-tx-list.tsx draws them): a soft bar, pulsing. Still
// under Reduce Motion.
import React from 'react'
import { type StyleProp, type ViewStyle } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { usePalette } from '../theme'
import { useReducedMotion } from './motion'

/** @keyframes pulse (Tailwind's animate-pulse) */
const pulse = css.keyframes({
  '0%': { opacity: 1 },
  '50%': { opacity: 0.5 },
  '100%': { opacity: 1 }
})
const PULSE_EASE = cubicBezier(0.4, 0, 0.6, 1)

export function SkeletonBar({ style }: { style: StyleProp<ViewStyle> }) {
  const palette = usePalette()
  const still = useReducedMotion()
  return (
    <Animated.View
      style={[
        style,
        { backgroundColor: palette.secondary },
        still ? null : { animationName: pulse, animationDuration: 2000, animationIterationCount: 'infinite', animationTimingFunction: PULSE_EASE }
      ]}
    />
  )
}
