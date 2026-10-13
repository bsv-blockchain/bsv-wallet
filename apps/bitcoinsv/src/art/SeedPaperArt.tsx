// The prototype's SeedPaperArt (components/home-card-stack.tsx): the
// recovery phrase as a tilted sheet of paper, twelve numbered lines, a gold
// key bobbing on the corner, and gold sparks drifting from each word's line
// into the key, one after another.
import React, { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { css } from 'react-native-reanimated'
import { KeyRound } from 'lucide-react-native'
import { font } from '../theme'
import { coinBob, useReducedMotion } from '../ui/motion'
import { Flat3D, Gradient, OVER_3D, SoftEllipse, edgeOffset, project } from '../ui/Soft'

const RX = 38
const RY = -8
const RZ = -12
const PERSPECTIVE = 700
const INK = '#1d1d1f'
const PAPER_W = 160
const PAPER_H = 112
const BOX = 160

const lineWidth = (i: number) => 55 + ((i * 37) % 40)

/** Each line's centre on the flat paper, as the prototype's layout puts it. */
function lineCentres(): { x: number; y: number }[] {
  // p-2.5, header (8px bold ≈ 11 tall) + gap-1.5, two columns gap-x-3, rows gap-y-1
  const pad = 10
  const gridTop = pad + 11 + 6
  const colW = (PAPER_W - pad * 2 - 12) / 2
  const rowH = 8
  return Array.from({ length: 12 }, (_, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const lineMax = colW - 10 - 4
    const w = (lineWidth(i) / 100) * lineMax
    return { x: pad + col * (colW + 12) + 14 + w / 2, y: gridTop + row * (rowH + 4) + rowH / 2 }
  })
}

/** @keyframes seed-spark, with this spark's way to the key. */
const sparkKeyframes = (dx: number, dy: number) =>
  css.keyframes({
    '0%': { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 0.4 }] },
    '15%': { opacity: 0.9, transform: [{ translateX: dx * 0.05 }, { translateY: dy * 0.05 - 3 }, { scale: 1 }] },
    '75%': { opacity: 0.8 },
    '100%': { opacity: 0, transform: [{ translateX: dx }, { translateY: dy }, { scale: 0.3 }] }
  })

export function SeedPaperArt() {
  const still = useReducedMotion()
  // the key: right-3 size-11. The prototype also sets bottom-6, but its coin-bob
  // keyframes animate `top` from 0, which wins, so the key rests at the top.
  const key = { x: BOX - 12 - 22, y: 22 }
  const sparks = useMemo(
    () =>
      lineCentres().map((c, i) => {
        const p = project(RX, RY, RZ, PERSPECTIVE, c.x - PAPER_W / 2, c.y - PAPER_H / 2)
        const x = BOX / 2 + p.x
        const y = BOX / 2 + p.y
        return { x, y, frames: sparkKeyframes(key.x - x, key.y - y), delay: i * 300 }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SoftEllipse frame={{ left: 24, top: 24, width: 112, height: 112 }} color="#ffffff" opacity={0.15} blur={40} />
      <SoftEllipse frame={{ left: 16, top: 128, width: 128, height: 20 }} color="#000000" opacity={0.5} blur={24} />
      <Flat3D>
      <View style={styles.paper}>
        {Array.from({ length: 4 }, (_, i) => {
          const o = edgeOffset(RX, RY, RZ, (i + 1) * 0.8)
          return <View key={i} style={[styles.edge, { transform: [{ translateX: o.x }, { translateY: o.y }] }]} />
        }).reverse()}
        <View style={styles.sheet}>
          <View style={styles.header}>
            <KeyRound size={10} color={INK} strokeWidth={2.4} />
            <Text style={[font(700), styles.headerText]}>Recovery phrase</Text>
          </View>
          <View style={styles.grid}>
            {Array.from({ length: 12 }, (_, i) => (
              <View key={i} style={styles.item}>
                <Text style={[font(600), styles.num]}>{i + 1}</Text>
                <View style={styles.lineTrack}>
                  <View style={[styles.line, { width: `${lineWidth(i)}%` }]} />
                </View>
              </View>
            ))}
          </View>
        </View>
        <Gradient
          direction="br"
          radius={8}
          stops={[
            { offset: 0, color: '#ffffff', opacity: 0.4 },
            { offset: 0.5, color: '#ffffff', opacity: 0 },
            { offset: 1, color: '#ffffff', opacity: 0 }
          ]}
        />
      </View>
      </Flat3D>
      {/* each word, a spark of gold on its way to the key */}
      {!still &&
        sparks.map((s, i) => (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              styles.spark,
              {
                left: s.x - 2,
                top: s.y - 2,
                animationName: s.frames,
                animationDuration: 3600,
                animationDelay: s.delay,
                animationIterationCount: 'infinite',
                animationTimingFunction: 'ease-in',
                animationFillMode: 'backwards'
              }
            ]}
          />
        ))}
      {/* the key it unlocks, resting on the corner */}
      <Animated.View
        style={[
          styles.key,
          still ? null : { animationName: coinBob, animationDuration: 5000, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }
        ]}
      >
        <KeyRound size={20} color={INK} strokeWidth={2.4} />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' },
  paper: {
    width: PAPER_W,
    height: PAPER_H,
    transform: [{ perspective: PERSPECTIVE }, { rotateX: `${RX}deg` }, { rotateY: `${RY}deg` }, { rotateZ: `${RZ}deg` }]
  },
  edge: { ...StyleSheet.absoluteFill, borderRadius: 8, backgroundColor: '#d9d4cc' },
  sheet: { ...StyleSheet.absoluteFill, borderRadius: 8, backgroundColor: '#fbf8f2', padding: 10, gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerText: { fontSize: 8, lineHeight: 11, color: INK },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  item: { width: (PAPER_W - 20 - 12) / 2, flexDirection: 'row', alignItems: 'center', gap: 4, height: 8 },
  num: { width: 10, textAlign: 'right', fontSize: 6, lineHeight: 8, color: 'rgba(29,29,31,0.45)' },
  lineTrack: { flex: 1 },
  line: { height: 4, borderRadius: 2, backgroundColor: 'rgba(29,29,31,0.25)' },
  spark: {
    position: 'absolute',
    zIndex: OVER_3D,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FFD54A',
    opacity: 0,
    boxShadow: '0 0 6px 2px rgba(234,179,0,0.55)'
  },
  key: {
    position: 'absolute',
    zIndex: OVER_3D,
    right: 12,
    top: 0,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EAB300',
    alignItems: 'center',
    justifyContent: 'center',
    // shadow-lg ring-2 ring-white/30
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 2px rgba(255,255,255,0.3)'
  }
})
