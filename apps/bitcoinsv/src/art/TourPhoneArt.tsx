// The prototype's TourPhoneArt (components/home-card-stack.tsx): a phone in
// the vault's tilted pose, alternating every 9s between the tour (a tiny Home
// under a dark overlay with one tile lit, a hand-written "Tap here") and the
// video (a dark frame with a pulsing play button). Reduced motion keeps the tour.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { Play } from 'lucide-react-native'
import { handwriting } from '../theme'
import { playPulse, tourArtA, tourArtB, useReducedMotion } from '../ui/motion'
import { Flat3D, Gradient, OVER_3D, SoftEllipse, edgeOffset } from '../ui/Soft'

const RX = 30
const RY = 12
const RZ = 14
const EDGE_LAYERS = 10
const INK = '#1d1d1f'

const cycle = (name: typeof tourArtA) => ({
  animationName: name,
  animationDuration: 9000,
  animationIterationCount: 'infinite' as const,
  animationTimingFunction: 'ease-in-out' as const
})

export function TourPhoneArt() {
  const still = useReducedMotion()
  const a = still ? {} : cycle(tourArtA)
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* inset-6 bg-white/15 blur-2xl; bottom-2 h-5 w-24 bg-black/50 blur-xl */}
      <SoftEllipse frame={{ left: 24, top: 24, width: 112, height: 112 }} color="#ffffff" opacity={0.15} blur={40} />
      <SoftEllipse frame={{ left: 32, top: 132, width: 96, height: 20 }} color="#000000" opacity={0.5} blur={24} />
      <Flat3D>
      <View style={styles.phone}>
        {Array.from({ length: EDGE_LAYERS }, (_, i) => {
          const o = edgeOffset(RX, RY, RZ, (i + 1) * 0.9)
          return <View key={i} style={[styles.edge, { transform: [{ translateX: o.x }, { translateY: o.y }] }]} />
        }).reverse()}
        <View style={styles.bezel}>
          <View style={styles.screen}>
            <View style={styles.notch} />
            {/* a tiny Home: top bar, balance, tiles, rows */}
            <View style={styles.row}>
              <View style={[styles.dot, { backgroundColor: hex(INK, 0.3) }]} />
              <View style={[styles.bar, { backgroundColor: hex(INK, 0.15) }]} />
            </View>
            <View style={styles.balance} />
            <View style={styles.row}>
              {[0, 1, 2].map(i => (
                <View key={i} style={styles.tile} />
              ))}
            </View>
            <View style={styles.line} />
            <View style={styles.line} />
            {/* the tour's overlay, with the middle tile let through */}
            <Animated.View style={[StyleSheet.absoluteFill, a]}>
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }]} />
              <View style={styles.litTile} />
            </Animated.View>
            {/* the video: a dark frame and its play button, pulsing */}
            {!still && (
              <Animated.View style={[StyleSheet.absoluteFill, styles.video, cycle(tourArtB)]}>
                <Gradient
                  stops={[
                    { offset: 0, color: '#2a2724', opacity: 1 },
                    { offset: 0.5, color: '#141312', opacity: 1 },
                    { offset: 1, color: '#070708', opacity: 1 }
                  ]}
                />
                <View style={styles.playWrap}>
                  <Animated.View
                    style={[
                      styles.pulse,
                      { animationName: playPulse, animationDuration: 1400, animationIterationCount: 'infinite', animationTimingFunction: 'ease-out' }
                    ]}
                  />
                  <View style={styles.play}>
                    <Play size={14} color="#000" fill="#000" strokeWidth={0} style={{ marginLeft: 2 }} />
                  </View>
                </View>
              </Animated.View>
            )}
          </View>
        </View>
        <Gradient
          direction="br"
          radius={16}
          stops={[
            { offset: 0, color: '#ffffff', opacity: 0.15 },
            { offset: 0.5, color: '#ffffff', opacity: 0 },
            { offset: 1, color: '#ffffff', opacity: 0 }
          ]}
        />
      </View>
      </Flat3D>
      {/* hand-written label and arrow, flat on top of the scene (with the tour) */}
      <Animated.Text style={[styles.tapHere, handwriting(700), a]}>Tap here</Animated.Text>
      <Animated.View style={[styles.arrow, a]}>
        <Svg width={56} height={56} viewBox="0 0 56 56" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M6 6 C 10 28, 26 40, 44 44" />
          <Path d="M34 47 L44 44 L38 36" />
        </Svg>
      </Animated.View>
    </View>
  )
}

/** '#rrggbb' at an alpha, as Tailwind's color/opacity. */
function hex(color: string, alpha: number) {
  return color + Math.round(alpha * 255).toString(16).padStart(2, '0')
}

const styles = StyleSheet.create({
  box: { width: 160, height: 160, alignItems: 'center', justifyContent: 'center' },
  phone: {
    width: 80,
    height: 144,
    transform: [{ perspective: 700 }, { rotateX: `${RX}deg` }, { rotateY: `${RY}deg` }, { rotateZ: `${RZ}deg` }]
  },
  edge: { ...StyleSheet.absoluteFill, borderRadius: 16, backgroundColor: '#0b0b0c' },
  bezel: {
    ...StyleSheet.absoluteFill,
    borderRadius: 16,
    backgroundColor: '#1b1b1e',
    padding: 4,
    boxShadow: '0 0 0 1px rgba(255,255,255,0.15)'
  },
  screen: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: '#f4f2f0',
    paddingHorizontal: 6,
    paddingTop: 16,
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden'
  },
  notch: { position: 'absolute', top: 4, alignSelf: 'center', height: 4, width: 20, borderRadius: 2, backgroundColor: '#1b1b1e' },
  row: { flexDirection: 'row', width: '100%', gap: 4, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bar: { height: 8, flex: 1, borderRadius: 4 },
  balance: { marginTop: 4, height: 10, width: 40, borderRadius: 5, backgroundColor: hex(INK, 0.35) },
  tile: { height: 20, flex: 1, borderRadius: 6, backgroundColor: hex(INK, 0.15) },
  line: { height: 6, width: '100%', borderRadius: 3, backgroundColor: hex(INK, 0.12) },
  litTile: {
    position: 'absolute',
    left: '38%',
    top: '45%',
    height: 20,
    width: '24%',
    borderRadius: 6,
    backgroundColor: '#f4f2f0',
    boxShadow: '0 0 0 2px #fff'
  },
  video: { alignItems: 'center', justifyContent: 'center', opacity: 0 },
  playWrap: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pulse: { position: 'absolute', width: 32, height: 32, borderRadius: 16, backgroundColor: '#fff' },
  play: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)'
  },
  tapHere: { position: 'absolute', zIndex: OVER_3D, left: -8, top: 4, fontSize: 24, lineHeight: 32, color: '#fff', transform: [{ rotate: '-8deg' }] },
  arrow: { position: 'absolute', zIndex: OVER_3D, left: 24, top: 32, width: 56, height: 56 }
})
