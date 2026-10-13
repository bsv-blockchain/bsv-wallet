// The prototype's HardwareKeyArt (app/(wallet)/vault/page.tsx): a generic
// hardware security key (USB-C plug on top, the gold touch contact in its
// body), tilted back and turned, its thickness drawn as darker copies of the
// silhouette behind the face. Waiting for a touch it straightens a little and
// the contact pulses.
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, css, cubicBezier, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg'
import { useIsDark, usePalette } from '../theme'
import { useReducedMotion } from '../ui/motion'

const BODY =
  'M40,30 H80 A18,18 0 0 1 98,48 V130 A18,18 0 0 1 80,148 H40 A18,18 0 0 1 22,130 V48 A18,18 0 0 1 40,30 Z M53,130 a7,7 0 1 0 14,0 a7,7 0 1 0 -14,0 Z'
const EDGE_LAYERS = 10

/** Tailwind's animate-ping: out to twice the size and gone by 75%, then a rest. */
const ping = css.keyframes({
  '0%': { opacity: 1, transform: [{ scale: 1 }] },
  '75%': { opacity: 0, transform: [{ scale: 2 }] },
  '100%': { opacity: 0, transform: [{ scale: 2 }] }
})
const PING = {
  animationName: ping,
  animationDuration: 1000,
  animationIterationCount: 'infinite',
  animationTimingFunction: cubicBezier(0, 0, 0.2, 1)
} as const

/** ink mixed 38% towards black, as the prototype's edge colour */
function darker(hex: string) {
  const n = parseInt(hex.slice(1, 7), 16)
  const f = (c: number) => Math.round(c * 0.62)
  const r = f((n >> 16) & 255)
  const g = f((n >> 8) & 255)
  const b = f(n & 255)
  return `rgb(${r},${g},${b})`
}

export function HardwareKeyArt({ waiting = false }: { waiting?: boolean }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const tilt = useSharedValue(waiting ? 1 : 0)
  useEffect(() => {
    tilt.value = withTiming(waiting ? 1 : 0, { duration: still ? 0 : 700, easing: Easing.bezier(0.34, 1.56, 0.64, 1) })
  }, [waiting, still, tilt])
  const key = useAnimatedStyle(() => ({
    transform: [
      { perspective: 700 },
      { rotateX: `${38 - 8 * tilt.value}deg` },
      { rotateY: `${-12 + 4 * tilt.value}deg` },
      { rotateZ: `${-24 + 8 * tilt.value}deg` }
    ]
  }))
  const glow = useAnimatedStyle(() => ({ opacity: 0.5 + 0.5 * tilt.value }))
  const edge = darker(palette.ink)
  return (
    <View style={styles.box} accessible={false} importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.glow, { backgroundColor: palette.gold + '40', boxShadow: `0 0 48px 24px ${palette.gold}40` }, glow]} />
      <View style={[styles.shadow, { backgroundColor: dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.25)', boxShadow: `0 0 20px 10px ${dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.25)'}` }]} />
      <Animated.View style={[styles.key, key]}>
        {Array.from({ length: EDGE_LAYERS }, (_, i) => (
          <Svg key={i} viewBox="0 0 120 160" style={[StyleSheet.absoluteFill, { transform: [{ translateY: (i + 1) * 0.9 }, { translateX: (i + 1) * 0.35 }] }]}>
            <Rect x="44" y="6" width="32" height="30" rx="5" fill={edge} />
            <Path d={BODY} fillRule="evenodd" fill={edge} />
          </Svg>
        )).reverse()}
        <Svg viewBox="0 0 120 160" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.18} />
              <Stop offset="0.55" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="44" y="6" width="32" height="30" rx="5" fill={palette.mutedForeground} />
          <Rect x="50" y="14" width="20" height="8" rx="4" fill={palette.background} fillOpacity={0.7} />
          <Path d={BODY} fillRule="evenodd" fill={palette.ink} />
          <Path d={BODY} fillRule="evenodd" fill="url(#sheen)" />
          <Circle cx="60" cy="80" r="20" fill={palette.gold} />
          <Circle cx="60" cy="80" r="13" fill="none" stroke={palette.goldForeground} strokeOpacity={0.4} strokeWidth={2} />
        </Svg>
        {waiting && !still && <Animated.View style={[styles.ping, { backgroundColor: palette.gold + '80' }, PING]} />}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { width: 208, height: 208, alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', top: 32, left: 32, right: 32, bottom: 32, borderRadius: 999 },
  shadow: { position: 'absolute', bottom: 26, alignSelf: 'center', width: 110, height: 12, borderRadius: 999 },
  key: { width: 120, height: 160 },
  // over the touch contact (60, 80 in the 120 × 160 box)
  ping: { position: 'absolute', left: 36, top: 56, width: 48, height: 48, borderRadius: 24 }
})
