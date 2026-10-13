// A payment's amount with its coin rolling in (the prototype's Money with
// `raised`, `mark` and `rollIn`, components/money.tsx): the figure raised
// (whole, then the decimals small), the coin's mark after it, and the coin
// rolling in from the left edge of the column (which clips it), turning as
// far as it travels, and uncovering the figure as it passes. Without motion
// (the phone's reduce motion), it simply shows.
import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View, type LayoutChangeEvent, type TextStyle } from 'react-native'
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import { font } from '../theme'
import { useReducedMotion } from './motion'

/** The column's own padding, which the clip reaches past to the screen's edge (-mx-4 px-4). */
const GUTTER = 16
const DURATION = 1150
const DELAY = 250
const EASE = Easing.bezier(0.25, 1, 0.4, 1)

export function RollingAmount({
  figure,
  unit,
  sign = '',
  mark,
  size = 48,
  color
}: {
  /** the number as shown: "0.00010023", "12.50" */
  figure: string
  /** after the figure, for a coin without a mark of its own ("USDC") */
  unit?: string
  sign?: string
  /** the coin, drawn at the size given */
  mark?: (size: number) => React.ReactNode
  size?: number
  color: string
}) {
  const still = useReducedMotion()
  const [figW, setFigW] = useState(0)
  // no coin to roll (a token without its own mark): the figure simply shows
  const rolls = !still && !!mark
  const p = useSharedValue(rolls ? 0 : 1)
  const m = figure.match(/^(.*?)(\.\d+)$/)
  const whole = m ? m[1] : figure
  const cents = m ? m[2] : ''
  const coin = size * 0.72
  const gap = size * 0.18
  // from just past the clip's left edge to its place, turning as far as it rolls
  const dx = GUTTER + figW + gap + coin + 4
  const turn = (dx / (Math.PI * coin)) * 360

  useEffect(() => {
    if (!figW || !rolls) return
    p.value = 0
    p.value = withDelay(DELAY, withTiming(1, { duration: DURATION, easing: EASE }))
  }, [figW, rolls, p])

  const coinStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -dx * (1 - p.value) }, { rotate: `${-turn * (1 - p.value)}deg` }]
  }))
  // the figure shows up to the coin's trailing edge, moving with it
  const shownStyle = useAnimatedStyle(() => ({
    width: Math.max(0, Math.min(figW, interpolate(p.value, [0, 1], [figW + gap - dx, figW + gap])))
  }))

  const text = (
    <View style={styles.row}>
      <Text style={[font(800), { color, fontSize: size, lineHeight: size * 1.15, letterSpacing: -size * 0.025, fontVariant: ['tabular-nums', 'lining-nums'] }]}>
        {sign}
        {whole}
      </Text>
      {!!cents && (
        <Text style={[font(800), { color, fontSize: size * 0.55, lineHeight: size * 0.6, marginTop: size * 0.14, fontVariant: ['tabular-nums', 'lining-nums'] }]}>
          {cents}
        </Text>
      )}
      {!!unit && <Text style={[font(800), { color, fontSize: size, lineHeight: size * 1.15, letterSpacing: -size * 0.025 }]}> {unit}</Text>}
    </View>
  )

  return (
    // the clip: the column, out to the screen's edge
    <View style={styles.mask} accessible accessibilityLabel={`${sign}${figure}${unit ? ` ${unit}` : mark ? ' BSV' : ''}`}>
      <View style={styles.row}>
        {figW === 0 ? (
          // measured once, unseen, so the reveal knows how wide the figure is
          <View style={styles.hidden} onLayout={(e: LayoutChangeEvent) => setFigW(Math.ceil(e.nativeEvent.layout.width))}>
            {text}
          </View>
        ) : (
          <View style={{ width: figW }}>
            <Animated.View style={[styles.clip, shownStyle]}>
              <View style={{ width: figW }}>{text}</View>
            </Animated.View>
          </View>
        )}
        {mark && (
          <Animated.View style={[{ marginLeft: gap, marginTop: size * 0.2, width: coin, height: coin }, figW ? coinStyle : styles.hidden]}>
            {mark(coin)}
          </Animated.View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  mask: { marginHorizontal: -GUTTER, paddingHorizontal: GUTTER, paddingVertical: 4, overflow: 'hidden', alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  clip: { overflow: 'hidden' },
  hidden: { opacity: 0 }
})

/**
 * The same figure, still (Money with `raised` and `mark`, no rollIn): whole,
 * the decimals at 0.55em raised 0.14em, then the coin's mark at 0.72em or
 * its unit.
 */
export function RaisedAmount({
  figure,
  unit,
  sign = '',
  mark,
  size = 48,
  color
}: {
  figure: string
  unit?: string
  sign?: string
  mark?: (size: number) => React.ReactNode
  size?: number
  color: string
}) {
  const m = figure.match(/^(.*?)(\.\d+)$/)
  const whole = m ? m[1] : figure
  const cents = m ? m[2] : ''
  const big = { color, fontSize: size, lineHeight: size * 1.15, letterSpacing: -size * 0.025, fontVariant: ['tabular-nums', 'lining-nums'] as TextStyle['fontVariant'] }
  return (
    <View style={styles.row} accessible accessibilityLabel={`${sign}${figure}${unit ? ` ${unit}` : mark ? ' BSV' : ''}`}>
      <Text style={[font(800), big]}>
        {sign}
        {whole}
      </Text>
      {!!cents && (
        <Text style={[font(800), { color, fontSize: size * 0.55, lineHeight: size * 0.6, marginTop: size * 0.14, fontVariant: ['tabular-nums', 'lining-nums'] }]}>
          {cents}
        </Text>
      )}
      {unit ? (
        <Text style={[font(800), big]}> {unit}</Text>
      ) : mark ? (
        <View style={{ marginLeft: size * 0.18, marginTop: size * 0.2 }}>{mark(size * 0.72)}</View>
      ) : null}
    </View>
  )
}
