// The prototype's FeedbackBackdrop (components/feedback-prompt.tsx): a dark
// card lit by three soft, slowly drifting blobs of colour, darkened towards
// the bottom. CSS draws each blob as a circle under `blur-3xl` (64px); here
// it is an SVG radial gradient over the same blurred extent, which renders
// the same falloff without a per-frame blur pass.
import React, { useState } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import Animated from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg'
import { feedbackBlob, useReducedMotion } from './motion'

/** Each tint's three blob colours (the prototype's TINTS, converted from OKLCH). */
export const TINTS = {
  gold: ['#eab30073', '#ff8a1f66', '#7a4dff40'],
  mint: ['#3fbf8673', '#00aebe66', '#c1af4138'],
  sky: ['#259ed673', '#00b5b566', '#dab33a38'],
  lavender: ['#9b7be973', '#e46c8361', '#4cb0e540']
} as const
export type Tint = keyof typeof TINTS

const BLUR = 64

/** Blob rectangles as fractions of the card: left, top, width, height (CSS insets and size-%). */
const BLOBS = [
  { left: -0.25, top: -0.25, w: 0.8, h: 0.8, duration: 14000, delay: 0, reverse: false },
  { right: -0.25, bottom: -1 / 3, w: 0.85, h: 0.85, duration: 18000, delay: 0, reverse: true },
  { left: 0.25, top: 1 / 3, w: 0.55, h: 0.55, duration: 11000, delay: -4000, reverse: false }
] as const

function Blob({
  color,
  id,
  frame,
  duration,
  delay,
  reverse,
  still
}: {
  color: string
  id: string
  frame: { x: number; y: number; w: number; h: number }
  duration: number
  delay: number
  reverse: boolean
  still: boolean
}) {
  const rgb = color.slice(0, 7)
  const alpha = parseInt(color.slice(7, 9), 16) / 255
  const W = frame.w + BLUR * 2
  const H = frame.h + BLUR * 2
  // where the solid circle ends inside the blurred extent
  const inner = Math.max(0, (Math.min(frame.w, frame.h) / 2 - BLUR) / (Math.min(W, H) / 2))
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: frame.x - BLUR,
        top: frame.y - BLUR,
        width: W,
        height: H,
        ...(still
          ? {}
          : {
              animationName: feedbackBlob(Math.max(frame.w, frame.h)),
              animationDuration: duration,
              animationDelay: delay,
              animationIterationCount: 'infinite',
              animationTimingFunction: 'ease-in-out',
              animationDirection: reverse ? 'reverse' : 'normal'
            })
      }}
    >
      <Svg width={W} height={H}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={rgb} stopOpacity={alpha} />
            <Stop offset={inner} stopColor={rgb} stopOpacity={alpha} />
            <Stop offset={inner + (1 - inner) * 0.5} stopColor={rgb} stopOpacity={alpha * 0.5} />
            <Stop offset="1" stopColor={rgb} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  )
}

export function Backdrop({ tint }: { tint: Tint }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const still = useReducedMotion()
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    if (!size || size.w !== width || size.h !== height) setSize({ w: width, h: height })
  }
  const colors = TINTS[tint]
  return (
    <View style={[StyleSheet.absoluteFill, styles.base]} onLayout={onLayout} pointerEvents="none">
      {size &&
        BLOBS.map((b, i) => {
          const w = b.w * size.w
          const h = b.h * size.h
          const x = 'left' in b ? b.left * size.w : size.w - w - b.right * size.w
          const y = 'top' in b ? b.top * size.h : size.h - h - b.bottom * size.h
          return (
            <Blob
              key={i}
              id={`blob-${tint}-${i}`}
              color={colors[i]}
              frame={{ x, y, w, h }}
              duration={b.duration}
              delay={b.delay}
              reverse={b.reverse}
              still={still}
            />
          )
        })}
      {/* bg-gradient-to-b from-black/10 via-transparent to-black/40 */}
      {size && (
      <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={`shade-${tint}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000" stopOpacity={0.1} />
            <Stop offset="0.5" stopColor="#000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.4} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={size.w} height={size.h} fill={`url(#shade-${tint})`} />
      </Svg>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  base: { backgroundColor: '#161618', overflow: 'hidden' }
})
