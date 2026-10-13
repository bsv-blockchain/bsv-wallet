// The prototype's tap hint (lib/tap-hint.ts showTap): a fingertip on a
// control, as in the explainer video. A soft white dot comes down on it,
// presses and lifts, leaving a gold ripple. For showing where something is;
// nothing is pressed. Resolves when it's done (at once with reduced motion).
import React, { useEffect, useState } from 'react'
import { StyleSheet, View, type View as ViewType } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated'
import { useReducedMotion } from './motion'

type Tap = { x: number; y: number; key: number; done: () => void }
let next = 0
const listeners = new Set<(t: Tap) => void>()
let reduced = false

export function showTap(target: ViewType | null): Promise<void> {
  if (!target || reduced || listeners.size === 0) return Promise.resolve()
  return new Promise(resolve => {
    target.measureInWindow((x, y, w, h) => {
      const tap = { x: x + w / 2, y: y + h / 2, key: ++next, done: resolve }
      listeners.forEach(l => l(tap))
    })
  })
}

function One({ tap }: { tap: Tap }) {
  const dot = useSharedValue(0)
  const press = useSharedValue(1.25)
  const ripple = useSharedValue(0)
  useEffect(() => {
    // comes down (200 ms), presses (140 ms), lifts away; the ripple spreads from the press
    dot.value = withSequence(withTiming(1, { duration: 200 }), withDelay(400, withTiming(0, { duration: 200 })))
    press.value = withSequence(
      withTiming(1, { duration: 200 }),
      withDelay(140, withTiming(0.8, { duration: 20 })),
      withDelay(120, withTiming(1, { duration: 120 }))
    )
    ripple.value = withDelay(350, withTiming(1, { duration: 500, easing: Easing.bezier(0.2, 0.8, 0.3, 1) }))
    const t = setTimeout(tap.done, 850)
    return () => clearTimeout(t)
  }, [dot, press, ripple, tap])
  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value, transform: [{ scale: press.value }] }))
  const rippleStyle = useAnimatedStyle(() => ({ opacity: ripple.value === 0 ? 0 : 1 - ripple.value, transform: [{ scale: 0.25 + 0.75 * ripple.value }] }))
  return (
    <>
      <Animated.View style={[styles.ripple, { left: tap.x - 60, top: tap.y - 60 }, rippleStyle]} />
      <Animated.View style={[styles.dot, { left: tap.x - 23, top: tap.y - 23 }, dotStyle]} />
    </>
  )
}

/** Mounted once at the root, over everything. */
export function TapHost() {
  const still = useReducedMotion()
  reduced = still
  const [tap, setTap] = useState<Tap | null>(null)
  useEffect(() => {
    listeners.add(setTap)
    return () => {
      listeners.delete(setTap)
    }
  }, [])
  if (!tap) return null
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <One key={tap.key} tap={tap} />
    </View>
  )
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.42)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.28)'
  },
  ripple: { position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: 'rgba(234,179,0,0.9)' }
})
