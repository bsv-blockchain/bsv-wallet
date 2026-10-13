// The prototype's celebrate() (components/success-view.tsx, canvas-confetti):
// a short burst of gold confetti from a point. canvas-confetti steps each
// particle per frame (velocity × 0.9 decay, +3px gravity, a wobble, a tilt,
// fading out over its ticks); here the same motion is computed in closed
// form from one shared clock on the UI thread, so 110 particles stay smooth.
import React, { useEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated'
import { useReducedMotion } from './motion'

const COLORS = ['#EAB300', '#FFD34D', '#F79E1B', '#1D1D1F', '#FFFFFF']
const DECAY = 0.9
const GRAVITY = 3
const FPS = 60

interface Particle {
  angle: number
  velocity: number
  wobble: number
  wobbleSpeed: number
  tiltSpeed: number
  color: string
  square: boolean
  ticks: number
}

/** canvas-confetti's randomPhysics, for one particle. */
function particle(angleDeg: number, spread: number, startVelocity: number, ticks: number): Particle {
  const rad = (d: number) => (d * Math.PI) / 180
  return {
    angle: -rad(angleDeg) + (0.5 * rad(spread) - Math.random() * rad(spread)),
    velocity: startVelocity * 0.5 + Math.random() * startVelocity,
    wobble: Math.random() * 10,
    wobbleSpeed: Math.min(0.11, Math.random() * 0.1 + 0.05),
    tiltSpeed: (Math.random() * 0.25 + 0.75) * 0.6,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    square: Math.random() < 0.5,
    ticks
  }
}

function Piece({ p, clock }: { p: Particle; clock: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const n = Math.min(p.ticks, clock.value * FPS)
    // Σ v·0.9^k for k < n: the distance travelled along the launch angle
    const run = (p.velocity * (1 - Math.pow(DECAY, n))) / (1 - DECAY)
    const wobble = p.wobble + p.wobbleSpeed * n
    const x = Math.cos(p.angle) * run + 10 * Math.cos(wobble)
    const y = Math.sin(p.angle) * run + GRAVITY * n + 10 * Math.sin(wobble)
    const tilt = Math.sin(p.tiltSpeed * n)
    return {
      opacity: 1 - n / p.ticks,
      transform: [{ translateX: x }, { translateY: y }, { rotate: `${p.tiltSpeed * n * 57}deg` }, { scaleY: Math.max(0.15, Math.abs(tilt)) }]
    }
  })
  return <Animated.View style={[styles.piece, { backgroundColor: p.color, borderRadius: p.square ? 1 : 5 }, style]} />
}

/**
 * Bursts once when mounted (or when `fire` changes): 110 pieces, spread 100°,
 * start velocity 36, from the centre of this view (place it over the origin).
 */
export function ConfettiBurst({ fire = 0, count = 110, spread = 100, startVelocity = 36, ticks = 220 }: { fire?: number; count?: number; spread?: number; startVelocity?: number; ticks?: number }) {
  const still = useReducedMotion()
  const clock = useSharedValue(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pieces = useMemo(() => Array.from({ length: count }, () => particle(90, spread, startVelocity, ticks)), [fire, count, spread, startVelocity, ticks])
  useEffect(() => {
    if (still) return
    clock.value = 0
    clock.value = withTiming(ticks / FPS, { duration: (ticks / FPS) * 1000, easing: Easing.linear })
  }, [fire, still, ticks, clock])
  if (still) return null
  return (
    <View pointerEvents="none" style={styles.origin}>
      {pieces.map((p, i) => (
        <Piece key={`${fire}-${i}`} p={p} clock={clock} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  origin: { position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, overflow: 'visible', zIndex: 60 },
  piece: { position: 'absolute', left: -5, top: -5, width: 10, height: 10 }
})
