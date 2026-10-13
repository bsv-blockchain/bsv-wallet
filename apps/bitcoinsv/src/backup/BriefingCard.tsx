// The briefing's screen, its filling button, and the hold-to-reveal gate
// (the prototype's components/key-briefing.tsx).
import React, { useEffect, useRef, useState, type RefObject } from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { BlurView } from 'expo-blur'
import * as Haptics from 'expo-haptics'
import { Check, Eye } from 'lucide-react-native'
import { font, useIsDark, usePalette } from '../theme'
import { enter, widthFill } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'
import { BriefingArt } from './BriefingArt'
import { FILL_MS, HOLD_MS, briefing, type KeyKind } from './briefing'

/** Tailwind's default transition curve, cubic-bezier(0.4, 0, 0.2, 1). */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/**
 * A fill sweeping left to right over `ms`, with the label drawn again over the
 * filled part in the fill's own text colour: the words turn as the fill
 * reaches them, instead of sitting light on the gold.
 */
function Sweep({ ms, fill, labelStyle, children }: { ms: number; fill: string; labelStyle?: ViewStyle; children: React.ReactNode }) {
  const [width, setWidth] = useState(0)
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          overflow: 'hidden',
          backgroundColor: fill,
          animationName: widthFill,
          animationDuration: ms,
          animationTimingFunction: 'linear',
          animationFillMode: 'both'
        }}
      >
        {/* the label at the button's full width, so it lines up with the one underneath */}
        <View style={[styles.sweepLabel, labelStyle, { width }]}>{children}</View>
      </Animated.View>
    </View>
  )
}

/**
 * A button that fills left to right over `ms`, and works once full. `ready`
 * skips the wait (a screen already read).
 */
export function FillButton({
  label,
  onPress,
  ms = FILL_MS,
  ready = false
}: {
  label: string
  onPress: () => void
  ms?: number
  ready?: boolean
}) {
  const palette = usePalette()
  const [full, setFull] = useState(ready)
  const [pressed, setPressed] = useState(false)
  useEffect(() => {
    if (ready) return
    const t = setTimeout(() => setFull(true), ms)
    return () => clearTimeout(t)
  }, [ms, ready])
  return (
    <Pressable
      disabled={!full}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={full ? label : `${label} (available in a moment)`}
      accessibilityState={{ disabled: !full }}
    >
      {/* transition-transform active:scale-[0.98] */}
      <Animated.View
        style={[
          styles.fill,
          full
            ? { backgroundColor: palette.gold, boxShadow: '0 10px 24px -10px rgba(234,179,0,0.7)' }
            : { backgroundColor: palette.gold + '40' },
          { transform: [{ scale: pressed ? 0.98 : 1 }], transitionProperty: 'transform', transitionDuration: 150, transitionTimingFunction: EASE }
        ]}
      >
      <Text style={[font(600), styles.fillText, { color: full ? palette.goldForeground : palette.foreground + 'b3' }]}>{label}</Text>
      {!full && (
        <Sweep ms={ms} fill={palette.gold}>
          <Text style={[font(600), styles.fillText, { color: palette.goldForeground }]}>{label}</Text>
        </Sweep>
      )}
      </Animated.View>
    </Pressable>
  )
}

/**
 * One screen of the briefing: its art, the point, where you are, and the
 * filling button.
 */
export function BriefingCard({ kind, i, seen, onNext }: { kind: KeyKind; i: number; seen: boolean; onNext: () => void }) {
  const palette = usePalette()
  const cards = briefing(kind)
  const card = cards[i]
  return (
    <View style={styles.card}>
      {/* the screen's art: one piece, whole, with room for its glow */}
      <Animated.View key={`a${i}`} style={[styles.art, enter({ opacity: 0, scale: 0.95, duration: 500 })]}>
        <BriefingArt i={i} kind={kind} />
      </Animated.View>

      <Animated.View key={`t${i}`} style={[styles.copy, enter({ opacity: 0, translateY: 4, duration: 500 })]}>
        <BalancedText accessibilityRole="header" style={[font(700), styles.title, { color: palette.foreground }]}>
          {card.title}
        </BalancedText>
        <BalancedText style={[font(400), styles.body, { color: palette.mutedForeground }]}>{card.body}</BalancedText>
      </Animated.View>

      {/* where you are */}
      <View style={styles.dots} accessibilityLabel={`${i + 1} of ${cards.length}`}>
        {cards.map((_, n) => (
          <Animated.View
            key={n}
            style={[
              styles.dot,
              { backgroundColor: n <= i ? palette.gold : palette.foreground + '26', transitionProperty: 'backgroundColor', transitionDuration: 150, transitionTimingFunction: EASE }
            ]}
          />
        ))}
      </View>

      <FillButton key={i} ready={seen} onPress={onNext} label={card.button} />
    </View>
  )
}

/**
 * Over the hidden key: the promises from the briefing, ticked, and "Press
 * and hold to reveal": a hold, not a tap, so it's never shown by accident.
 */
export function RevealGate({
  kind,
  onReveal,
  blurTarget
}: {
  kind: KeyKind
  onReveal: () => void
  /** Android: the view the backdrop blurs (iOS blurs whatever is behind) */
  blurTarget?: RefObject<View | null>
}) {
  const palette = usePalette()
  const dark = useIsDark()
  const promises = briefing(kind).flatMap(c => (c.promise ? [c.promise] : []))
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = () => {
    setHolding(true)
    void Haptics.selectionAsync().catch(() => {})
    timer.current = setTimeout(() => {
      setHolding(false)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      onReveal()
    }, HOLD_MS)
  }
  const stop = () => {
    setHolding(false)
    if (timer.current) clearTimeout(timer.current)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return (
    <View style={styles.gate}>
      {/* bg-background/70 backdrop-blur-sm */}
      <BlurView
        intensity={12}
        tint={dark ? 'dark' : 'light'}
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        style={[StyleSheet.absoluteFill, styles.gateBlur]}
      />
      <View style={[StyleSheet.absoluteFill, styles.gateBlur, { backgroundColor: palette.background + 'b3' }]} />
      <Text style={[font(600), styles.gateTitle, { color: palette.foreground }]}>
        Reveal your {kind === 'phrase' ? 'recovery phrase' : 'key slices'}
      </Text>
      <View style={styles.promises}>
        {promises.map((p, n) => (
          <Animated.View key={p} style={[styles.promise, enter({ opacity: 0, translateX: -4, duration: 300, delay: n * 90 })]}>
            <View style={[styles.tick, { backgroundColor: palette.gold }]}>
              <Check size={12} color={palette.goldForeground} strokeWidth={3.5} />
            </View>
            <Text style={[font(400), styles.promiseText, { color: palette.foreground }]}>{p}</Text>
          </Animated.View>
        ))}
      </View>
      <Pressable
        onPressIn={start}
        onPressOut={stop}
        accessibilityRole="button"
        accessibilityLabel="Press and hold to reveal"
        accessibilityActions={[{ name: 'activate' }]}
        // a screen reader's double-tap can't hold: it reveals straight away
        onAccessibilityAction={onReveal}
        style={[styles.hold, { backgroundColor: palette.ink }]}
      >
        <Eye size={16} color={palette.inkForeground} />
        <Text style={[font(600), styles.holdText, { color: palette.inkForeground }]}>Press and hold to reveal</Text>
        {holding && (
          <Sweep ms={HOLD_MS} fill={palette.gold} labelStyle={styles.holdLabel}>
            <Eye size={16} color={palette.goldForeground} />
            <Text style={[font(600), styles.holdText, { color: palette.goldForeground }]}>Press and hold to reveal</Text>
          </Sweep>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { height: 56, width: '100%', borderRadius: 999, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  fillText: { fontSize: 15, lineHeight: 20 },
  holdLabel: { justifyContent: 'flex-start', paddingHorizontal: 20 },
  sweepLabel: { height: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  card: { flex: 1 },
  art: { alignItems: 'center', paddingTop: 32 },
  copy: { flex: 1, alignItems: 'center', gap: 8, paddingTop: 8 },
  title: { textAlign: 'center', fontSize: 24, lineHeight: 32, letterSpacing: -0.6 },
  body: { maxWidth: 320, textAlign: 'center', fontSize: 15, lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 24 },
  dot: { height: 4, width: 24, borderRadius: 2 },
  gate: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    borderRadius: 16,
    padding: 16
  },
  gateBlur: { borderRadius: 16, overflow: 'hidden' },
  gateTitle: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  promises: { gap: 8 },
  promise: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tick: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  promiseText: { fontSize: 13, lineHeight: 18 },
  hold: {
    marginTop: 4,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    overflow: 'hidden',
    borderRadius: 999,
    paddingHorizontal: 20
  },
  holdText: { fontSize: 14, lineHeight: 20 }
})
