// The prototype's components/transfer-timeline.tsx: steps lighting up one
// after another, ending settled. Here it follows real progress: `reached` is
// how many steps are really done, and each step still stays current for at
// least 650ms, so a fast restore reads as a checklist rather than a flash.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { Check } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { useReducedMotion } from '../ui/motion'

/** Each step is current for at least this long. */
const STEP_MS = 650

/** Tailwind's default transition curve. */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/** @keyframes ping — Tailwind's animate-ping. */
const ping = css.keyframes({
  '0%': { opacity: 1, transform: [{ scale: 1 }] },
  '75%': { opacity: 0, transform: [{ scale: 2 }] },
  '100%': { opacity: 0, transform: [{ scale: 2 }] }
})

export function TransferTimeline({
  steps,
  reached,
  onSettled
}: {
  steps: string[]
  /** how many steps are really done (steps.length once it's all finished) */
  reached: number
  /** once every step shows done */
  onSettled?: () => void
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [completed, setCompleted] = useState(0)
  const settled = useRef(false)
  const settle = useRef(onSettled)
  useEffect(() => {
    settle.current = onSettled
  }, [onSettled])

  useEffect(() => {
    if (completed >= steps.length) {
      if (!settled.current) {
        settled.current = true
        settle.current?.()
      }
      return
    }
    if (completed >= reached) return
    const t = setTimeout(() => setCompleted(c => c + 1), STEP_MS)
    return () => clearTimeout(t)
  }, [completed, reached, steps.length])

  return (
    <View style={styles.list} accessibilityRole="progressbar" accessibilityLabel={steps[Math.min(completed, steps.length - 1)]}>
      {steps.map((label, i) => {
        const isDone = i < completed
        const isActive = i === completed
        return (
          <View key={label} style={styles.row}>
            <View style={styles.rail}>
              {/* transition-all duration-300 */}
              <Animated.View
                style={[
                  styles.dot,
                  { backgroundColor: isDone ? palette.gold : isActive ? palette.gold + '40' : palette.secondary },
                  { transitionProperty: 'backgroundColor', transitionDuration: 300, transitionTimingFunction: EASE }
                ]}
              >
                {isDone ? (
                  <Check size={12} color={palette.goldForeground} strokeWidth={3.2} />
                ) : isActive ? (
                  <Animated.View
                    style={[
                      styles.ping,
                      { backgroundColor: palette.gold },
                      still
                        ? null
                        : { animationName: ping, animationDuration: 1000, animationIterationCount: 'infinite', animationTimingFunction: cubicBezier(0, 0, 0.2, 1) }
                    ]}
                  />
                ) : null}
              </Animated.View>
              {i < steps.length - 1 && (
                <Animated.View
                  style={[
                    styles.line,
                    { backgroundColor: i < completed - 1 ? palette.gold + 'b3' : palette.border },
                    { transitionProperty: 'backgroundColor', transitionDuration: 500, transitionTimingFunction: EASE }
                  ]}
                />
              )}
            </View>
            <Animated.Text
              style={[
                font(isDone || isActive ? 500 : 400),
                styles.label,
                i < steps.length - 1 && styles.gap,
                { color: isDone || isActive ? palette.foreground : palette.mutedForeground },
                { transitionProperty: 'color', transitionDuration: 300, transitionTimingFunction: EASE }
              ]}
            >
              {label}
            </Animated.Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 320 },
  row: { flexDirection: 'row', gap: 12 },
  rail: { alignItems: 'center' },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  ping: { width: 6, height: 6, borderRadius: 3 },
  line: { width: 1, flex: 1 },
  label: { flex: 1, paddingTop: 2, fontSize: 14, lineHeight: 20 },
  gap: { paddingBottom: 24 }
})
