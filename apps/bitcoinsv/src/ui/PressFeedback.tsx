// The prototype's press feel for its CTA tiles (.glass-btn and lib/ripple.ts):
// a slight press-down, and a soft disc about the button's height growing out
// from the exact touch point while it fades, behind the label.
import React, { useCallback, useRef, useState } from 'react'
import { Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { EASE_PRESS, useReducedMotion } from './motion'

const ripple = css.keyframes({
  from: { opacity: 1, transform: [{ scale: 0 }] },
  to: { opacity: 0, transform: [{ scale: 1 }] }
})
const RIPPLE_EASE = cubicBezier(0.2, 0.6, 0.3, 1)

export function PressFeedback({
  onPress,
  style,
  rippleColor,
  accessibilityLabel,
  disabled = false,
  children
}: {
  onPress: () => void
  style: ViewStyle | ViewStyle[]
  rippleColor: string
  accessibilityLabel?: string
  /** .glass-btn:disabled — opacity 0.55, saturate(0.4); no press */
  disabled?: boolean
  children: React.ReactNode
}) {
  const still = useReducedMotion()
  const [pressed, setPressed] = useState(false)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const height = useRef(0)
  const nextId = useRef(0)
  const onLayout = (e: LayoutChangeEvent) => (height.current = e.nativeEvent.layout.height)
  const onPressIn = useCallback(
    (e: GestureResponderEvent) => {
      setPressed(true)
      if (still) return
      const id = ++nextId.current
      setRipples(r => [...r, { id, x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }])
      setTimeout(() => setRipples(r => r.filter(p => p.id !== id)), 950)
    },
    [still]
  )
  const radius = height.current * 0.9
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onLayout={onLayout}
    >
      <Animated.View
        style={[
          style,
          styles.clip,
          disabled && styles.disabled,
          {
            transform: [{ translateY: pressed ? 0.5 : 0 }, { scale: pressed ? 0.995 : 1 }],
            transitionProperty: 'transform',
            transitionDuration: 250,
            transitionTimingFunction: EASE_PRESS
          }
        ]}
      >
        {ripples.map(r => (
          <Animated.View
            key={r.id}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: r.x - radius,
              top: r.y - radius,
              width: radius * 2,
              height: radius * 2,
              borderRadius: radius,
              backgroundColor: rippleColor,
              animationName: ripple,
              animationDuration: 900,
              animationTimingFunction: RIPPLE_EASE,
              animationFillMode: 'forwards'
            }}
          />
        ))}
        <View style={styles.label}>{children}</View>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.55 },
  clip: { overflow: 'hidden' },
  label: { alignItems: 'center', gap: 8 }
})
