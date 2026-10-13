// The prototype's SetupChecklist (components/setup-checklist.tsx): a new
// wallet's first steps on Home, ticked off as they're done. The card goes
// once they all are, or when hidden. "Add money" is Top up (Later) and is
// left out, as the prototype does in Now.
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { Check, ChevronRight, RotateCcw, X } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'

const EASE = cubicBezier(0.4, 0, 0.2, 1)

export interface SetupStep {
  label: string
  done: boolean
  onPress: () => void
  /** done, it can still be taken again from here */
  again?: boolean
}

export function SetupChecklist({ steps, onHide }: { steps: SetupStep[]; onHide: () => void }) {
  const palette = usePalette()
  const done = steps.filter(s => s.done).length
  if (done === steps.length) return null
  return (
    <View style={[styles.card, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]} accessibilityLabel="Get set up">
      <View style={styles.head}>
        <Text style={[font(600), styles.title, { color: palette.foreground }]}>Get set up</Text>
        <Text style={[font(400), styles.count, { color: palette.mutedForeground }]}>
          {done} of {steps.length}
        </Text>
        <Pressable onPress={onHide} accessibilityRole="button" accessibilityLabel="Hide the checklist" hitSlop={8} style={({ pressed }) => [styles.close, pressed && { backgroundColor: palette.secondary }]}>
          <X size={16} color={palette.mutedForeground} />
        </Pressable>
      </View>
      <View style={[styles.track, { backgroundColor: palette.secondary }]}>
        <Animated.View
          style={{
            height: '100%',
            borderRadius: 3,
            backgroundColor: palette.gold,
            width: `${(done / steps.length) * 100}%`,
            transitionProperty: 'width',
            transitionDuration: 500,
            transitionTimingFunction: 'ease-out'
          }}
        />
      </View>
      <View style={styles.list}>
        {steps.map(s => {
          const inactive = s.done && !s.again
          return (
            <Pressable
              key={s.label}
              disabled={inactive}
              onPress={s.onPress}
              accessibilityRole="button"
              accessibilityState={{ checked: s.done }}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
            >
              {/* transition-colors: the gold fills in over 150ms */}
              <Animated.View
                style={[
                  styles.tick,
                  {
                    boxShadow: `0 0 0 1px ${s.done ? palette.gold : palette.border}`,
                    backgroundColor: s.done ? palette.gold : 'transparent',
                    transitionProperty: 'backgroundColor',
                    transitionDuration: 150,
                    transitionTimingFunction: EASE
                  }
                ]}
              >
                {s.done && <Check size={14} color={palette.goldForeground} strokeWidth={3} />}
              </Animated.View>
              <Text
                style={[
                  font(500),
                  styles.label,
                  { color: s.done ? palette.mutedForeground : palette.foreground },
                  s.done && styles.struck
                ]}
              >
                {s.label}
              </Text>
              {!s.done && <ChevronRight size={16} color={palette.mutedForeground} />}
              {s.done && s.again && (
                <View style={styles.again}>
                  <RotateCcw size={14} color={palette.mutedForeground} />
                  <Text style={[font(600), styles.againText, { color: palette.mutedForeground }]}>Again</Text>
                </View>
              )}
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radii['3xl'], padding: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingTop: 4 },
  title: { flex: 1, fontSize: 15, lineHeight: 22 },
  count: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  close: { marginRight: -4, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  track: { marginHorizontal: 8, marginTop: 10, height: 6, borderRadius: 3, overflow: 'hidden' },
  list: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 10 },
  tick: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1, fontSize: 14, lineHeight: 20 },
  struck: { textDecorationLine: 'line-through' },
  again: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  againText: { fontSize: 12, lineHeight: 16 }
})
