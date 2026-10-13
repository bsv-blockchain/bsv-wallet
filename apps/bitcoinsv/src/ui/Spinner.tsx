// The prototype's busy spinner: lucide Loader2 with `animate-spin` (one turn
// a second, linear), inline before a label.
import React from 'react'
import Animated from 'react-native-reanimated'
import { Loader2 } from 'lucide-react-native'
import { spin } from './motion'

export function Spinner({ size = 16, color, strokeWidth = 2 }: { size?: number; color: string; strokeWidth?: number }) {
  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={{ width: size, height: size, animationName: spin, animationDuration: 1000, animationIterationCount: 'infinite', animationTimingFunction: 'linear' }}
    >
      <Loader2 size={size} color={color} strokeWidth={strokeWidth} />
    </Animated.View>
  )
}
