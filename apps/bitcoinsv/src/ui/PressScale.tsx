// Tailwind's `active:scale-*` with `transition-transform` (150ms,
// cubic-bezier(0.4, 0, 0.2, 1)): the press eases down and back instead of
// snapping. A Pressable whose content shrinks to `scale` while held.
import React, { useState } from 'react'
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'

const EASE = cubicBezier(0.4, 0, 0.2, 1)

export function PressScale({
  scale = 0.97,
  style,
  pressedStyle,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  /** the active:scale-* value */
  scale?: number
  /** the content's own style (size, fill, radius) */
  style?: StyleProp<ViewStyle>
  /** extra style while held (an active: background) */
  pressedStyle?: StyleProp<ViewStyle>
  children: React.ReactNode
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <Pressable
      {...rest}
      onPressIn={e => {
        setPressed(true)
        onPressIn?.(e)
      }}
      onPressOut={e => {
        setPressed(false)
        onPressOut?.(e)
      }}
    >
      <Animated.View
        style={[
          style,
          pressed && pressedStyle,
          {
            transform: [{ scale: pressed ? scale : 1 }],
            transitionProperty: 'transform',
            transitionDuration: 150,
            transitionTimingFunction: EASE
          }
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  )
}
