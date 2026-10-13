// The prototype's SlicePuzzle (components/slice-scanner.tsx): the three key
// slices as numbered jigsaw pieces. Missing ones are dashed outlines; scanned
// ones fill with gold. With enough of them the pieces slide together and
// lock into one key, and the missing one comes back too: that's what the
// threshold means.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg'
import { Check } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { useReducedMotion } from '../ui/motion'

export const SLICE_TOTAL = 3
export const SLICE_NEEDED = 2

// a piece: a tab on its right, a notch on its left
const W = 84
const H = 64
const R = 11
/** the prototype's viewBox width: three pieces, two 16px gaps, the last tab, 2px margins */
const VIEW_W = W * SLICE_TOTAL + 16 * (SLICE_TOTAL - 1) + R + 4
const VIEW_H = H + 4
const SPRING = cubicBezier(0.34, 1.56, 0.64, 1)

function piecePath(notch: boolean, tab: boolean) {
  const top = H / 2 - R
  return [
    `M0 0 H${W}`,
    tab ? `V${top} A${R} ${R} 0 1 1 ${W} ${top + 2 * R} V${H}` : `V${H}`,
    'H0',
    notch ? `V${top + 2 * R} A${R} ${R} 0 1 0 0 ${top} V0` : 'V0',
    'Z'
  ].join(' ')
}

export function SlicePuzzle({
  scanned,
  width = 320,
  caption = true
}: {
  scanned: number[]
  width?: number
  /** "Your key is whole again" once enough are in */
  caption?: boolean
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const complete = scanned.length >= SLICE_NEEDED
  const gap = complete ? 0 : 16
  const used = W * SLICE_TOTAL + gap * (SLICE_TOTAL - 1) + R
  const k = Math.min(width, 320) / VIEW_W
  const offset = (VIEW_W - 4 - used) / 2
  const move = (ms: number) =>
    still
      ? null
      : { transitionProperty: 'transform' as const, transitionDuration: ms, transitionTimingFunction: SPRING }
  const fade = (ms: number) => (still ? null : { transitionProperty: 'opacity' as const, transitionDuration: ms })

  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        complete ? 'Key slices joined into your key' : `${scanned.length} of ${SLICE_TOTAL} key slices scanned`
      }
    >
      <View style={{ width: VIEW_W * k, height: VIEW_H * k }}>
        {Array.from({ length: SLICE_TOTAL }, (_, i) => {
          const n = i + 1
          const got = scanned.includes(n)
          // with enough slices, the missing one is rebuilt
          const rebuilt = complete && !got
          const d = piecePath(i > 0, i < SLICE_TOTAL - 1)
          const box = { width: (W + R + 4) * k, height: VIEW_H * k }
          const view = `-2 -2 ${W + R + 4} ${VIEW_H}`
          return (
            <Animated.View
              key={n}
              style={[styles.piece, box, { transform: [{ translateX: (offset + i * (W + gap)) * k }] }, move(700)]}
            >
              {/* the outline, always there; the fills fade over it */}
              <Svg width={box.width} height={box.height} viewBox={view} style={StyleSheet.absoluteFill}>
                <Path
                  d={d}
                  fill="transparent"
                  stroke={palette.mutedForeground + '73'}
                  strokeWidth={1.6}
                  strokeDasharray="5 4"
                  strokeLinejoin="round"
                />
              </Svg>
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: rebuilt ? 1 : 0 }, fade(500)]}>
                <Svg width={box.width} height={box.height} viewBox={view}>
                  <Path
                    d={d}
                    fill="rgba(234,179,0,0.28)"
                    stroke="rgba(234,179,0,0.7)"
                    strokeWidth={1.6}
                    strokeLinejoin="round"
                  />
                </Svg>
              </Animated.View>
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: got ? 1 : 0 }, fade(500)]}>
                <Svg width={box.width} height={box.height} viewBox={view}>
                  <Defs>
                    <LinearGradient id={`slice-gold-${n}`} x1="0" y1="0" x2="1" y2="1">
                      <Stop offset="0" stopColor="#ffd84a" />
                      <Stop offset="1" stopColor="#eab300" />
                    </LinearGradient>
                  </Defs>
                  <Path
                    d={d}
                    fill={`url(#slice-gold-${n})`}
                    stroke="#c99700"
                    strokeWidth={1.6}
                    strokeLinejoin="round"
                  />
                </Svg>
              </Animated.View>
              <View style={[styles.number, { width: (W + 4) * k, height: VIEW_H * k }]}>
                <Animated.Text
                  style={[
                    font(700),
                    {
                      fontSize: 22 * k,
                      lineHeight: 28 * k,
                      color: got ? '#1d1d1f' : rebuilt ? '#8a6400' : palette.mutedForeground + '99'
                    },
                    // transition-colors duration-500
                    !still && { transitionProperty: 'color', transitionDuration: 500, transitionTimingFunction: cubicBezier(0.4, 0, 0.2, 1) }
                  ]}
                >
                  {n}
                </Animated.Text>
              </View>
            </Animated.View>
          )
        })}
      </View>
      {/* joined: a tick */}
      {caption && (
        <Animated.View
          style={[styles.whole, { opacity: complete ? 1 : 0 }, fade(500)]}
          importantForAccessibility="no-hide-descendants"
        >
          <Check size={16} color={palette.positive} strokeWidth={3} />
          <Text style={[font(600), styles.wholeText, { color: palette.positive }]}>Your key is whole again</Text>
        </Animated.View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: 8 },
  piece: { position: 'absolute', left: 0, top: 0 },
  number: { position: 'absolute', left: 0, top: 0, alignItems: 'center', justifyContent: 'center' },
  whole: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wholeText: { fontSize: 14, lineHeight: 20 }
})
