// The prototype's FlipCard (components/flip-card.tsx): a card that turns over
// once something is `done`. After `delay` it squeezes shut (scaleX 1 → 0,
// 230ms ease-in), swaps to `back` and opens again (230ms ease-out), with a
// burst of confetti from the card's centre. A flat flip keeps the back crisp;
// both faces share one cell so the card keeps its height. Once it has turned,
// tapping it turns it over again, either way.
import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { usePalette } from '../theme'
import { ConfettiBurst } from '../ui/Confetti'
import { useReducedMotion } from '../ui/motion'

const TURN = 230

export function FlipCard({ done, back, delay = 2000, children }: { done: boolean; back: React.ReactNode; delay?: number; children: React.ReactNode }) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [face, setFace] = useState<'front' | 'back'>('front')
  const [turning, setTurning] = useState(false)
  // tappable once the first turn has landed
  const [ready, setReady] = useState(false)
  const [burst, setBurst] = useState(0)
  // the two faces share one cell: the card is as tall as the taller one
  const [frontH, setFrontH] = useState(0)
  const [backH, setBackH] = useState(0)
  const cell = Math.max(frontH, backH)
  const flipTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!done) return
    const turn = setTimeout(() => setTurning(true), delay)
    const land = setTimeout(() => {
      setTurning(false)
      setFace('back')
      setReady(true)
      setBurst(b => b + 1)
    }, delay + TURN)
    return () => {
      clearTimeout(turn)
      clearTimeout(land)
    }
  }, [done, delay])
  useEffect(() => () => clearTimeout(flipTimer.current), [])

  // turn it over by hand: squeeze shut, swap faces, open again
  const flip = () => {
    if (!ready || turning) return
    setTurning(true)
    flipTimer.current = setTimeout(() => {
      setTurning(false)
      setFace(f => (f === 'back' ? 'front' : 'back'))
    }, TURN)
  }

  return (
    // above what follows, so the confetti falls over the buttons
    <View style={styles.wrap}>
      <Pressable onPress={flip} disabled={!ready} accessibilityRole={ready ? 'button' : undefined} accessibilityLabel={ready ? 'Turn the card over' : undefined}>
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: palette.card,
              boxShadow: `0 0 0 1px ${palette.border}`,
              transform: [{ scaleX: turning ? 0 : 1 }],
              transitionProperty: 'transform',
              transitionDuration: still ? 0 : TURN,
              transitionTimingFunction: turning ? 'ease-in' : 'ease-out'
            }
          ]}
        >
          <View style={{ minHeight: cell }}>
            <View
              onLayout={e => setFrontH(e.nativeEvent.layout.height)}
              style={face === 'back' && styles.hidden}
              importantForAccessibility={face === 'back' ? 'no-hide-descendants' : 'auto'}
              accessibilityElementsHidden={face === 'back'}
            >
              {children}
            </View>
            {/* always laid out (unseen until it turns) so the cell knows its height */}
            <View
              onLayout={e => setBackH(e.nativeEvent.layout.height)}
              style={[styles.back, { top: Math.max(0, (cell - backH) / 2) }, face === 'front' && styles.hidden]}
              importantForAccessibility={face === 'front' ? 'no-hide-descendants' : 'auto'}
              accessibilityElementsHidden={face === 'front'}
            >
              {back}
            </View>
          </View>
        </Animated.View>
      </Pressable>
      {burst > 0 && <ConfettiBurst key={burst} count={110} spread={100} startVelocity={36} />}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { zIndex: 10 },
  // rounded-3xl bg-card p-5 ring-1 ring-border
  card: { borderRadius: 24, padding: 20 },
  hidden: { opacity: 0 },
  back: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 12 }
})
