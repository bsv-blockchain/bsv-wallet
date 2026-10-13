// The prototype's CardStack and StackCard (components/home-card-stack.tsx).
// Cards sit on top of each other; the ones behind peek out below, smaller and
// darker, lit along the bottom in their own colour. The arrows, or a sideways
// swipe, bring the next one forward with the prototype's springy 500ms
// shuffle. Only the front card can be used.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { Backdrop, type Tint } from '../ui/Backdrop'
import { EASE_SPRING } from '../ui/motion'
import { PressScale } from '../ui/PressScale'
import { Gradient } from '../ui/Soft'
import { BalancedText } from '../ui/BalancedText'

export interface StackItem {
  id: string
  node: React.ReactElement
  /** the card's own colour, lit along its bottom when it sits behind */
  glow?: string
}

/** Tailwind's default transition curve */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

const PEEK = 14
const RADIUS = 32

export function CardStack({
  cards,
  peek = PEEK,
  control = 'arrows'
}: {
  cards: StackItem[]
  /** how far each card behind shows below (the small stack's is 8) */
  peek?: number
  /** the big stack's pill of arrows and dots, or the small one's dots alone */
  control?: 'arrows' | 'dots'
}) {
  const palette = usePalette()
  const [front, setFront] = useState(0)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const n = cards.length
  if (n === 0) return null
  const top = ((front % n) + n) % n
  const go = (step: number) => setFront(top + step)
  // every card as tall as the tallest (they share one grid cell in the prototype)
  const cardHeight = Math.max(0, ...cards.map(c => heights[c.id] ?? 0))
  const measure = (id: string) => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height)
    setHeights(prev => (prev[id] && prev[id] >= h ? prev : { ...prev, [id]: h }))
  }

  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onEnd(e => {
      if (n > 1 && Math.abs(e.translationX) > 50) go(e.translationX < 0 ? 1 : -1)
    })

  return (
    <View style={[styles.wrap, control === 'dots' && { gap: 4 }]}>
      <GestureDetector gesture={swipe}>
        <View style={{ width: '100%', height: cardHeight ? cardHeight + (n - 1) * peek : undefined }}>
          {cards.map((c, i) => {
            const depth = (i - top + n) % n
            return (
              <Animated.View
                key={c.id}
                pointerEvents={depth > 0 ? 'none' : 'auto'}
                accessibilityElementsHidden={depth > 0}
                importantForAccessibility={depth > 0 ? 'no-hide-descendants' : 'auto'}
                onLayout={measure(c.id)}
                style={[
                  cardHeight ? styles.layer : styles.measuring,
                  cardHeight ? { minHeight: cardHeight } : null,
                  {
                    zIndex: n - depth,
                    transformOrigin: '50% 100%',
                    transform: [{ translateY: depth * peek }, { scale: 1 - depth * 0.05 }],
                    transitionProperty: 'transform',
                    transitionDuration: 500,
                    transitionTimingFunction: EASE_SPRING
                  }
                ]}
              >
                {c.node}
                {/* the cards behind: their own colour along the bottom, where they peek out */}
                {c.glow && (
                  <Animated.View
                    pointerEvents="none"
                    style={[styles.glow, { opacity: depth > 0 ? 1 : 0, transitionProperty: 'opacity', transitionDuration: 500, transitionTimingFunction: EASE }]}
                  >
                    <Gradient
                      direction="t"
                      stops={[
                        { offset: 0, color: c.glow.slice(0, 7), opacity: parseInt(c.glow.slice(7, 9), 16) / 255 },
                        { offset: 1, color: c.glow.slice(0, 7), opacity: 0 }
                      ]}
                    />
                  </Animated.View>
                )}
                {/* brightness(1 - depth * 0.1): over the glow too, as the filter darkens it */}
                <Animated.View
                  pointerEvents="none"
                  style={[
                    [styles.dim, control === 'dots' && { borderRadius: 20 }],
                    { opacity: depth * (control === 'arrows' ? 0.1 : 0.06), transitionProperty: 'opacity', transitionDuration: 500, transitionTimingFunction: EASE_SPRING }
                  ]}
                />
              </Animated.View>
            )
          })}
        </View>
      </GestureDetector>

      {n > 1 && control === 'dots' && (
        // compact: each dot is a button, padded for a finger
        <View style={styles.compact}>
          {cards.map((c, i) => (
            <Pressable
              key={c.id}
              onPress={() => setFront(i)}
              accessibilityRole="button"
              accessibilityLabel={`Show card ${i + 1} of ${n}`}
              accessibilityState={{ selected: i === top }}
              style={styles.dotHit}
            >
              <Animated.View
                style={{
                  height: 6,
                  borderRadius: 3,
                  width: i === top ? 16 : 6,
                  backgroundColor: palette.foreground,
                  opacity: i === top ? 1 : 0.25,
                  transitionProperty: ['width', 'opacity'],
                  transitionDuration: 300,
                  transitionTimingFunction: EASE
                }}
              />
            </Pressable>
          ))}
        </View>
      )}
      {n > 1 && control === 'arrows' && (
        <View style={[styles.pager, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
          <Pressable onPress={() => go(-1)} accessibilityRole="button" accessibilityLabel="Previous card" style={({ pressed }) => [styles.arrow, pressed && { backgroundColor: palette.secondary }]}>
            <ChevronLeft size={20} color={palette.foreground} />
          </Pressable>
          <View style={styles.dots} accessibilityLabel={`Card ${top + 1} of ${n}`}>
            {cards.map((c, i) => (
              <Animated.View
                key={c.id}
                style={{
                  height: 8,
                  borderRadius: 4,
                  width: i === top ? 20 : 8,
                  backgroundColor: palette.foreground,
                  opacity: i === top ? 1 : 0.25,
                  transitionProperty: ['width', 'opacity'],
                  transitionDuration: 300,
                  transitionTimingFunction: EASE
                }}
              />
            ))}
          </View>
          <Pressable onPress={() => go(1)} accessibilityRole="button" accessibilityLabel="Next card" style={({ pressed }) => [styles.arrow, pressed && { backgroundColor: palette.secondary }]}>
            <ChevronRight size={20} color={palette.foreground} />
          </Pressable>
        </View>
      )}
    </View>
  )
}

/** One big card: backdrop, art, title and a line, an action. */
export function StackCard({
  tint,
  art,
  title,
  body,
  action
}: {
  tint: Tint
  art: React.ReactNode
  title: string
  body: string
  action: React.ReactNode
}) {
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Backdrop tint={tint} />
      {/* a light rim and a lit bottom edge, so stacked dark cards read as separate cards */}
      <View pointerEvents="none" style={styles.hairline}>
        <Gradient
          direction="r"
          stops={[
            { offset: 0, color: '#ffffff', opacity: 0 },
            { offset: 0.5, color: '#ffffff', opacity: 0.45 },
            { offset: 1, color: '#ffffff', opacity: 0 }
          ]}
        />
      </View>
      <View pointerEvents="none" style={styles.bottomLight}>
        <Gradient
          direction="t"
          stops={[
            { offset: 0, color: '#ffffff', opacity: 0.07 },
            { offset: 1, color: '#ffffff', opacity: 0 }
          ]}
        />
      </View>
      <View style={styles.content}>
        <View style={styles.art}>{art}</View>
        <BalancedText style={[font(700), styles.title]} accessibilityRole="header">
          {title}
        </BalancedText>
        {/* text-balance */}
        <BalancedText style={[font(400), styles.body]}>
          {body}
        </BalancedText>
        <View style={styles.action}>{action}</View>
      </View>
    </View>
  )
}

/** The white pill CTA on the dark cards. */
export function CardCta({ label, onPress }: { label: string; onPress: () => void }) {
  // active:scale-[0.98] over the default 150ms transition
  return (
    <PressScale onPress={onPress} accessibilityRole="button" scale={0.98} style={styles.cta}>
      <Text style={[font(600), styles.ctaText]}>{label}</Text>
    </PressScale>
  )
}

/** The quiet second action under a CTA ("Not now"). */
export function CardLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.link}>
      <Text style={[font(600), styles.linkText]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 12 },
  measuring: { width: '100%', position: 'absolute', opacity: 0 },
  layer: { position: 'absolute', left: 0, right: 0, top: 0 },
  dim: { ...StyleSheet.absoluteFill, borderRadius: RADIUS, backgroundColor: '#000', zIndex: 30 },
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 40,
    borderBottomLeftRadius: RADIUS,
    borderBottomRightRadius: RADIUS,
    overflow: 'hidden',
    zIndex: 20
  },
  card: {
    flex: 1,
    borderRadius: RADIUS,
    overflow: 'hidden',
    // shadow, and ring-1 ring-white/12 (a ring takes no layout space)
    boxShadow: '0 10px 28px -8px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.12)'
  },
  hairline: { position: 'absolute', left: 32, right: 32, bottom: 0, height: 1, zIndex: 10 },
  bottomLight: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, zIndex: 10 },
  content: { flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: 32, paddingBottom: 28 },
  art: { height: 160, alignItems: 'center', justifyContent: 'center' },
  // tracking-tight (full width: Android mis-measures shrink-wrapped centred text)
  title: { width: '100%', paddingTop: 16, fontSize: 24, lineHeight: 32, letterSpacing: -0.6, color: '#fff', textAlign: 'center' },
  body: { width: '100%', paddingTop: 8, fontSize: 15, lineHeight: 24.4, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
  action: { marginTop: 'auto', width: '100%', paddingTop: 24 },
  cta: { height: 56, width: '100%', borderRadius: 28, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: 16, lineHeight: 24, color: '#161618' },
  link: { height: 40, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  linkText: { fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.7)' },
  pager: { flexDirection: 'row', alignItems: 'center', borderRadius: 999, padding: 4 },
  arrow: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 },
  compact: { flexDirection: 'row', alignItems: 'center' },
  dotHit: { height: 28, justifyContent: 'center', paddingHorizontal: 4 }
})
