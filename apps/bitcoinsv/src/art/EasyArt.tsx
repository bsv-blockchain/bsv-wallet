// Welcome screen 1, "No crypto skills needed" (the prototype's EasyArt in
// components/why-art.tsx): a tilted phone swapping every 3s between a
// finished payment (the check pops in with a burst of confetti) and your
// savings (a ring fills round the lock, then it opens), with reassurances
// floating around it and a facepile of people paying you.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { Easing, useAnimatedProps, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { Image } from 'expo-image'
import { Check, Lock, LockOpen } from 'lucide-react-native'
import { font, useIsDark, usePalette } from '../theme'
import { AVATAR_BACKGROUNDS, type AvatarBg } from '../ui/Avatar'
import { barFill, confettiBurst, enter, popIn, useReducedMotion, whyFloat } from '../ui/motion'
import { cubicBezier } from 'react-native-reanimated'
import { OVER_3D, SoftEllipse } from '../ui/Soft'
import { TiltedPhone } from './TiltedPhone'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const POP = cubicBezier(0.34, 1.8, 0.64, 1)

const BITS = [
  { dx: -22, dy: -14, c: '#EAB300' },
  { dx: 20, dy: -16, c: '#16a34a' },
  { dx: -26, dy: 6, c: '#f97316' },
  { dx: 25, dy: 8, c: '#EAB300' },
  { dx: -10, dy: -24, c: '#3b82f6' },
  { dx: 12, dy: -24, c: '#ec4899' },
  { dx: -18, dy: 20, c: '#16a34a' },
  { dx: 18, dy: 20, c: '#3b82f6' }
].map(b => ({ ...b, frames: confettiBurst(b.dx, b.dy) }))

const CHIPS = [
  { label: 'Tap and pay', pos: { right: 12, top: 56 }, delay: 800 },
  { label: 'Under 1¢ fees', pos: { left: 16, bottom: 40 }, delay: 1600 },
  { label: 'Safe for savings', pos: { right: 12, bottom: 80 }, delay: 2400 }
]

export function EasyArt() {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  // the phone swaps between a payment and your savings, every 3 seconds
  const [savings, setSavings] = useState(false)
  // counts each swap, so the animations inside replay every time round
  const [cycle, setCycle] = useState(0)
  // the savings screen starts locked and opens once its ring has filled
  const [unlocked, setUnlocked] = useState(false)
  const onSavings = useRef(false)
  useEffect(() => {
    let open: ReturnType<typeof setTimeout> | undefined
    const t = setInterval(() => {
      onSavings.current = !onSavings.current
      setSavings(onSavings.current)
      setCycle(c => c + 1)
      setUnlocked(false)
      clearTimeout(open)
      if (onSavings.current) open = setTimeout(() => setUnlocked(true), 1500)
    }, 3000)
    return () => {
      clearInterval(t)
      clearTimeout(open)
    }
  }, [])

  const fade = (on: boolean) => ({ opacity: on ? 1 : 0, transitionProperty: 'opacity' as const, transitionDuration: 700 })
  const chip = [styles.chip, { backgroundColor: palette.card, boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}` }]
  const float = (delay: number) =>
    still ? null : { animationName: whyFloat, animationDuration: 4000, animationDelay: delay, animationIterationCount: 'infinite' as const, animationTimingFunction: 'ease-in-out' as const }

  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SoftEllipse frame={{ left: 48, top: 48, width: 192, height: 224 }} color={palette.gold} opacity={0.25} blur={40} />
      <SoftEllipse frame={{ left: 80, top: 272, width: 128, height: 24 }} color="#000000" opacity={dark ? 0.6 : 0.25} blur={24} />
      <TiltedPhone pose={{ scale: 1.15, rx: 30, ry: 12, rz: 14 }}>
        {/* two screens, cross-fading: a payment made, and savings kept safe */}
        <Animated.View style={[styles.screen, fade(!savings)]}>
          <Text style={[font(600), styles.tiny, { color: palette.mutedForeground }]}>Bay Café</Text>
          <Text style={[font(800), styles.amount, { color: palette.foreground }]}>$6.00</Text>
          {/* replays each time the payment screen comes round */}
          <PaidCheck key={`paid-${cycle}`} active={!savings} still={still} />
          <Text style={[font(700), styles.tiny, { paddingTop: 6, color: palette.foreground }]}>Paid</Text>
          <View style={[styles.button, { backgroundColor: palette.gold }]}>
            <Text style={[font(700), styles.tiny, { color: palette.goldForeground }]}>Done</Text>
          </View>
        </Animated.View>
        <Animated.View style={[styles.screen, fade(savings)]}>
          <Text style={[font(600), styles.tiny, { color: palette.mutedForeground }]}>Savings</Text>
          {/* hidden until it's unlocked, then the balance shows */}
          <Animated.Text
            key={unlocked ? 'shown' : 'hidden'}
            style={[
              font(800),
              styles.amount,
              { color: palette.foreground },
              unlocked ? (still ? null : enter({ scale: 0.9, duration: 300 })) : { letterSpacing: 1.8 }
            ]}
          >
            {unlocked ? '$2,180' : '••••'}
          </Animated.Text>
          <UnlockRing key={`lock-${cycle}`} active={savings} open={unlocked} still={still} />
          <Text style={[font(700), styles.tiny, { paddingTop: 6, color: palette.foreground }]}>Stored safely</Text>
          <Text style={[font(400), { fontSize: 6.5, lineHeight: 9, color: palette.mutedForeground }]}>Only you can open it</Text>
          {/* the button fills left to right in step with the ring round the lock */}
          <View key={`unlock-${cycle}`} style={[styles.button, { backgroundColor: palette.secondary, overflow: 'hidden' }]}>
            {savings && (
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    borderRadius: 10,
                    backgroundColor: palette.gold,
                    transformOrigin: 'left',
                    ...(still
                      ? {}
                      : { animationName: barFill, animationDuration: 1200, animationDelay: 300, animationTimingFunction: 'ease-in-out', animationFillMode: 'both' })
                  }
                ]}
              />
            )}
            <Text style={[font(700), styles.tiny, { color: palette.goldForeground }]}>{unlocked ? 'Unlocked' : 'Unlocking…'}</Text>
          </View>
        </Animated.View>
      </TiltedPhone>
      {CHIPS.map(c => (
        <Animated.View key={c.label} style={[chip, c.pos, float(c.delay)]}>
          <Text style={[font(600), styles.chipText, { color: palette.foreground }]}>{c.label}</Text>
        </Animated.View>
      ))}
      {/* friends paying you: a little facepile */}
      <Animated.View style={[chip, styles.facepileChip, { left: 12, top: 24 }, float(0)]}>
        <Text style={[font(600), styles.chipText, { color: palette.foreground }]}>Get paid</Text>
        <RotatingFaces />
      </Animated.View>
    </View>
  )
}

/** The payment's green check: pops in with a little overshoot, and a burst of tiny confetti. */
function PaidCheck({ active, still }: { active: boolean; still: boolean }) {
  const palette = usePalette()
  return (
    <View style={styles.check}>
      <Animated.View
        style={[
          styles.checkDisc,
          { backgroundColor: palette.positive },
          active && !still ? { animationName: popIn, animationDuration: 600, animationDelay: 200, animationTimingFunction: POP, animationFillMode: 'both' } : null
        ]}
      >
        <Check size={20} color="#fff" strokeWidth={3} />
      </Animated.View>
      {active &&
        !still &&
        BITS.map((b, i) => (
          <Animated.View
            key={i}
            style={[
              styles.bit,
              { backgroundColor: b.c, animationName: b.frames, animationDuration: 900, animationDelay: 450, animationTimingFunction: 'ease-out', animationFillMode: 'both' }
            ]}
          />
        ))}
    </View>
  )
}

const RING_R = 18
const RING_C = 2 * Math.PI * RING_R

/** The savings lock: a ring fills round its edge, and once it's closed the lock opens. */
function UnlockRing({ active, open, still }: { active: boolean; open: boolean; still: boolean }) {
  const palette = usePalette()
  const offset = useSharedValue(still ? 0 : RING_C)
  useEffect(() => {
    if (active && !still) {
      // ring-fill 1.2s ease-in-out 300ms
      offset.value = withDelay(300, withTiming(0, { duration: 1200, easing: Easing.bezier(0.42, 0, 0.58, 1) }))
    }
  }, [active, still, offset])
  const progress = useAnimatedProps(() => ({ strokeDashoffset: offset.value }))
  const fg = open ? palette.goldForeground : palette.foreground
  return (
    // grey while locked; gold once it opens
    <Animated.View
      style={[
        styles.ring,
        { backgroundColor: open ? palette.gold : palette.secondary, transitionProperty: 'backgroundColor', transitionDuration: 500 }
      ]}
    >
      <Svg width={44} height={44} viewBox="0 0 40 40" style={styles.ringSvg}>
        <Circle cx={20} cy={20} r={RING_R} fill="none" stroke={fg} strokeOpacity={0.15} strokeWidth={2.5} />
        {active && (
          <AnimatedCircle
            cx={20}
            cy={20}
            r={RING_R}
            fill="none"
            stroke="#1d1d1f"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={[RING_C, RING_C]}
            animatedProps={progress}
          />
        )}
      </Svg>
      {open ? (
        <Animated.View key="open" style={still ? null : enter({ scale: 0.5, opacity: 1, duration: 300 })}>
          <LockOpen size={18} color={fg} strokeWidth={2.6} />
        </Animated.View>
      ) : (
        <Lock size={18} color={fg} strokeWidth={2.6} />
      )}
    </Animated.View>
  )
}

const PORTRAIT = {
  dragon: require('../../assets/avatars/dragon.png'),
  whale: require('../../assets/avatars/whale.png'),
  unicorn: require('../../assets/avatars/unicorn.png'),
  frog: require('../../assets/avatars/frog.png'),
  phoenix: require('../../assets/avatars/phoenix.png'),
  bull: require('../../assets/avatars/bull.png')
}
const PHOTO = {
  anna: require('../../assets/people/anna.jpg'),
  marco: require('../../assets/people/marco.jpg'),
  lena: require('../../assets/people/lena.jpg'),
  sam: require('../../assets/people/sam.jpg'),
  priya: require('../../assets/people/priya.jpg'),
  jonas: require('../../assets/people/jonas.jpg')
}

/** People who'd pay you: photos and animal portraits on their colours. */
const FACES: ({ photo: number } | { portrait: number; bg: AvatarBg })[] = [
  { photo: PHOTO.anna },
  { portrait: PORTRAIT.dragon, bg: 'mint' },
  { photo: PHOTO.marco },
  { portrait: PORTRAIT.whale, bg: 'sky' },
  { photo: PHOTO.lena },
  { portrait: PORTRAIT.unicorn, bg: 'lavender' },
  { photo: PHOTO.sam },
  { portrait: PORTRAIT.frog, bg: 'butter' },
  { photo: PHOTO.priya },
  { portrait: PORTRAIT.phoenix, bg: 'peach' },
  { photo: PHOTO.jonas },
  { portrait: PORTRAIT.bull, bg: 'rose' }
]

/** One face at a time swaps for someone not already showing, every 1.4s. */
function RotatingFaces() {
  const palette = usePalette()
  const still = useReducedMotion()
  const [faces, setFaces] = useState([0, 1, 2])
  const tick = useRef(0)
  useEffect(() => {
    const t = setInterval(() => {
      tick.current += 1
      setFaces(shown => {
        const slot = tick.current % shown.length
        let n = Math.max(...shown) + 1
        while (shown.includes(n % FACES.length)) n++
        const next = [...shown]
        next[slot] = n % FACES.length
        return next
      })
    }, 1400)
    return () => clearInterval(t)
  }, [])
  return (
    <View style={styles.faces}>
      {faces.map((f, i) => {
        const face = FACES[f]
        return (
          <Animated.View
            key={`${i}-${f}`}
            style={[
              styles.face,
              { zIndex: 3 - i, marginLeft: i > 0 ? -8 : 0, boxShadow: `0 0 0 2px ${palette.card}` },
              'bg' in face ? { backgroundColor: AVATAR_BACKGROUNDS[face.bg], justifyContent: 'flex-end', alignItems: 'center' } : null,
              still ? null : enter({ scale: 0.75, duration: 500 })
            ]}
          >
            {'photo' in face ? (
              <Image source={face.photo} style={{ width: 24, height: 24 }} />
            ) : (
              <Image source={face.portrait} style={{ width: '86%', height: '86%' }} contentFit="contain" contentPosition="bottom" />
            )}
          </Animated.View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  // h-80 w-72 scale-[1.32]
  box: { width: 288, height: 320, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 1.32 }] },
  screen: { position: 'absolute', left: 8, right: 8, top: 20, bottom: 0, alignItems: 'center' },
  tiny: { fontSize: 8, lineHeight: 11 },
  amount: { paddingTop: 4, fontSize: 18, lineHeight: 18 },
  button: { marginBottom: 10, marginTop: 'auto', height: 20, width: '100%', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  check: { marginTop: 12, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  checkDisc: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  bit: { position: 'absolute', left: 16, top: 16, width: 4, height: 4, borderRadius: 1 },
  ring: { marginTop: 12, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ringSvg: { position: 'absolute', left: -4, top: -4, transform: [{ rotate: '-90deg' }] },
  chip: { position: 'absolute', zIndex: OVER_3D, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 12, lineHeight: 16 },
  facepileChip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingLeft: 12, paddingRight: 4 },
  faces: { flexDirection: 'row' },
  face: { width: 24, height: 24, borderRadius: 12, overflow: 'hidden', backgroundColor: '#fff' }
})
