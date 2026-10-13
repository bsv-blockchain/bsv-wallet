// The art for each screen of the key briefing (the prototype's
// components/key-briefing-art.tsx), in the app's tilted 3D style: phones and
// paper leaning in space, gold badges, white chips floating around (the risky
// ones struck out), a soft glow, and a little motion that loops. Reduced
// motion holds it still.
import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import Animated, { type css } from 'react-native-reanimated'
import {
  Camera,
  Check,
  Cloud,
  EyeOff,
  FileText,
  Headset,
  KeyRound,
  MonitorUp,
  PenLine,
  Smartphone,
  UserRound,
  Users,
  VenetianMask,
  type LucideIcon
} from 'lucide-react-native'
import { SeedPaperArt } from '../art/SeedPaperArt'
import { SlicePuzzle } from '../art/SlicePuzzle'
import { TiltedPhone } from '../art/TiltedPhone'
import { font, useIsDark, usePalette } from '../theme'
import { BsvMark } from '../ui/BsvMark'
import { briefCoinAway, briefDrop, briefStamp, briefWrite, coinBob, dataRefused, dataStrike, playPulse, useReducedMotion } from '../ui/motion'
import { Flat3D, OVER_3D, SoftEllipse } from '../ui/Soft'
import type { KeyKind } from './briefing'

// h-60 w-72
const W = 288
const H = 240
const PAPER = '#fbf8f2'
const INK = '#1d1d1f'
const lineWidth = (n: number) => `${55 + ((n * 37) % 40)}%` as const

export function BriefingArt({ i, kind }: { i: number; kind: KeyKind }) {
  switch (i) {
    case 0:
      return <PrivateArt />
    case 1:
      return <WhatArt kind={kind} />
    case 2:
      return <TakenArt />
    case 3:
      return <NeverShareArt />
    case 4:
      return <WriteArt />
    case 5:
      return <DontLoseArt />
    case 6:
      return <ReadyArt />
    default:
      return null
  }
}

/** A looping CSS animation, or nothing under reduced motion. */
function useLoop() {
  const still = useReducedMotion()
  return (
    name: ReturnType<typeof css.keyframes>,
    duration: number,
    delay = 0,
    easing: 'ease-in-out' | 'ease-in' | 'ease-out' | 'linear' = 'ease-in-out'
  ): object | null =>
    still
      ? null
      : {
          animationName: name,
          animationDuration: duration,
          animationDelay: delay,
          animationIterationCount: 'infinite',
          animationTimingFunction: easing,
          animationFillMode: 'both'
        }
}

/** The stage every piece stands on: its glow and its shadow, nothing clipped. */
function Stage({ glow, children }: { glow?: string; children: React.ReactNode }) {
  const palette = usePalette()
  const dark = useIsDark()
  return (
    <View style={styles.stage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* inset-10 blur-2xl */}
      <SoftEllipse frame={{ left: 40, top: 40, width: W - 80, height: H - 80 }} color={glow ?? palette.gold} opacity={glow ? 0.15 : 0.25} blur={40} />
      {/* bottom-6, h-6 w-32, blur-xl */}
      <SoftEllipse frame={{ left: W / 2 - 64, top: H - 24 - 24, width: 128, height: 24 }} color="#000000" opacity={dark ? 0.6 : 0.2} blur={24} />
      {children}
    </View>
  )
}

/** A floating white chip; `struck` draws a red line through it as it arrives (and loops). */
function Chip({
  icon: Icon,
  label,
  pos,
  delay = 0,
  struck = false,
  tone
}: {
  icon: LucideIcon
  label: string
  pos: ViewStyle
  delay?: number
  struck?: boolean
  tone?: 'good' | 'bad'
}) {
  const palette = usePalette()
  const loop = useLoop()
  const color = tone === 'good' ? palette.positive : tone === 'bad' ? palette.destructive : palette.mutedForeground
  return (
    <Animated.View
      style={[
        styles.chip,
        pos,
        {
          backgroundColor: palette.card,
          boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}`
        },
        loop(dataRefused, 4500, delay * 1000)
      ]}
    >
      <Icon size={14} color={color} />
      <View>
        <Text style={[font(600), styles.chipText, { color: palette.foreground }]}>{label}</Text>
        {struck && (
          <Animated.View
            style={[styles.strike, { backgroundColor: palette.destructive, transformOrigin: 'left' }, loop(dataStrike, 4500, delay * 1000)]}
          />
        )}
      </View>
    </Animated.View>
  )
}

/** A gold badge with an icon, the app's emblem style. */
function Badge({ icon: Icon, size = 48, style }: { icon: LucideIcon; size?: number; style?: object | null | (object | null)[] }) {
  const palette = usePalette()
  return (
    <Animated.View
      style={[
        styles.round,
        {
          width: size,
          height: size,
          backgroundColor: palette.gold,
          boxShadow: `0 0 0 4px ${palette.background}, 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)`
        },
        style
      ]}
    >
      <Icon size={size * 0.48} color={palette.goldForeground} strokeWidth={2.4} />
    </Animated.View>
  )
}

/** Twelve word bars, as a phrase looks on a screen. */
function WordBars({ blurred = false }: { blurred?: boolean }) {
  const palette = usePalette()
  return (
    <View style={styles.bars}>
      {Array.from({ length: 12 }, (_, n) => (
        <View key={n} style={styles.barCell}>
          <Text style={[font(700), styles.barNum, { color: palette.mutedForeground }, blurred && styles.softText]}>{n + 1}</Text>
          <View
            style={[
              styles.bar,
              { backgroundColor: palette.foreground + '40' },
              // blur-[2.5px]: a soft halo in place of a filter
              blurred && { backgroundColor: palette.foreground + '26', boxShadow: `0 0 3px 1px ${palette.foreground}2e` }
            ]}
          />
        </View>
      ))}
    </View>
  )
}

/* ── 1 · Is your screen private? ── */
function PrivateArt() {
  const palette = usePalette()
  return (
    <Stage>
      <TiltedPhone pose={{ scale: 1.2, rx: 22, ry: -18, rz: -8 }}>
        <Text style={[font(800), styles.phoneTitle, { color: palette.foreground }]}>Recovery phrase</Text>
        <WordBars blurred />
        <View style={styles.eyeRow}>
          <View style={[styles.round, styles.eye, { backgroundColor: palette.ink }]}>
            <EyeOff size={16} color={palette.inkForeground} />
          </View>
        </View>
      </TiltedPhone>
      <Chip icon={Camera} label="Cameras" pos={{ left: 0, top: 24 }} struck />
      <Chip icon={MonitorUp} label="Screen sharing" pos={{ right: 0, top: 80 }} delay={0.9} struck />
      <Chip icon={Users} label="Someone helping" pos={{ bottom: 32, left: 8 }} delay={1.8} struck />
    </Stage>
  )
}

/* ── 2 · What is it? ── */
function WhatArt({ kind }: { kind: KeyKind }) {
  const loop = useLoop()
  const still = useReducedMotion()
  // slices: the three pieces apart, then coming together, again and again
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (kind !== 'slices' || still) return
    const t = setInterval(() => setStep(s => (s + 1) % 4), 1300)
    return () => clearInterval(t)
  }, [kind, still])
  if (kind === 'phrase')
    return (
      <Stage>
        <SeedPaperArt />
      </Stage>
    )
  const scanned = [[1], [1, 3], [1, 3], []][step]
  return (
    <Stage>
      <SlicePuzzle scanned={scanned} width={256} />
      <Badge icon={KeyRound} style={[styles.over, { position: 'absolute', right: 24, top: 16 }, loop(coinBob, 5000)]} />
    </Stage>
  )
}

/* ── 3 · Anyone with it can take your money ── */
function TakenArt() {
  const palette = usePalette()
  const loop = useLoop()
  const still = useReducedMotion()
  return (
    <Stage glow={palette.destructive}>
      <View style={{ transform: [{ translateX: -48 }] }}>
        <TiltedPhone pose={{ scale: 1.1, rx: 24, ry: 16, rz: 8 }}>
          <Text style={[font(700), styles.tiny6, { color: palette.mutedForeground }]}>Total balance</Text>
          <Text style={[font(800), styles.zero, { color: palette.foreground }]}>$0.00</Text>
          <View style={styles.sentList}>
            {[0, 1, 2].map(n => (
              <View key={n} style={[styles.sentRow, { backgroundColor: palette.secondary }]}>
                <View style={[styles.sentDot, { backgroundColor: palette.destructive + 'b3' }]} />
                <Text style={[font(700), styles.tiny55, { color: palette.foreground }]}>Sent to someone else</Text>
              </View>
            ))}
          </View>
        </TiltedPhone>
      </View>
      {/* coins leaving, one after another, for the stranger */}
      {!still &&
        Array.from({ length: 5 }, (_, n) => (
          <Animated.View key={n} style={[styles.coin, loop(briefCoinAway, 2400, n * 450, 'ease-in')]}>
            <BsvMark size={24} />
          </Animated.View>
        ))}
      <View style={styles.stranger}>
        <View
          style={[
            styles.round,
            styles.mask,
            { backgroundColor: palette.ink, boxShadow: `0 0 0 4px ${palette.background}, 0 10px 15px -3px rgba(0,0,0,0.1)` }
          ]}
        >
          <VenetianMask size={28} color={palette.inkForeground} />
        </View>
        <View style={[styles.label, { backgroundColor: palette.card, boxShadow: `0 1px 3px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}` }]}>
          <Text style={[font(600), styles.labelText, { color: palette.foreground }]}>Someone else</Text>
        </View>
      </View>
    </Stage>
  )
}

/* ── 4 · Never share it ── */
function NeverShareArt() {
  const palette = usePalette()
  const loop = useLoop()
  return (
    <Stage>
      <TiltedPhone pose={{ scale: 1.22, rx: 20, ry: -20, rz: -6 }}>
        <View style={styles.supportRow}>
          <View style={[styles.round, styles.supportIcon, { backgroundColor: palette.secondary }]}>
            <Headset size={10} color={palette.foreground} />
          </View>
          <Text style={[font(700), styles.tiny6, { color: palette.foreground }]}>“Support”</Text>
        </View>
        <View style={[styles.bubble, { backgroundColor: palette.secondary }]}>
          <Text style={[font(600), styles.bubbleText, { color: palette.foreground }]}>Hi! To check your wallet, please send me your 12 words.</Text>
        </View>
        {/* stamped, a moment after it arrives */}
        <Animated.View
          style={[styles.stamp, { borderColor: palette.destructive, transform: [{ rotate: '-10deg' }] }, loop(briefStamp, 3000, 0, 'ease-out')]}
        >
          <Text style={[font(900), styles.stampText, { color: palette.destructive }]}>SCAM</Text>
        </Animated.View>
      </TiltedPhone>
      <Chip icon={UserRound} label="Friends" pos={{ left: 0, top: 32 }} struck />
      <Chip icon={Users} label="Family" pos={{ right: 8, top: 56 }} delay={0.9} struck />
      <Chip icon={Headset} label="“Support”" pos={{ bottom: 32, right: 24 }} delay={1.8} struck />
    </Stage>
  )
}

/* ── 5 · Write it down ── */
function WriteArt() {
  const loop = useLoop()
  return (
    <Stage>
      {/* paper, tilted like the recovery phrase sheet, the words being written */}
      <Flat3D>
        <View style={[styles.paper, styles.writePaper, { transform: [{ perspective: 700 }, { rotateX: '38deg' }, { rotateZ: '-10deg' }] }]}>
          <View style={styles.paperHead}>
            <PenLine size={10} color={INK} />
            <Text style={[font(700), styles.paperTitle8]}>Recovery phrase</Text>
          </View>
          <View style={styles.writeGrid}>
            {Array.from({ length: 12 }, (_, n) => (
              <View key={n} style={styles.writeCell}>
                <Text style={[font(600), styles.writeNum]}>{n + 1}</Text>
                <View style={styles.writeTrack}>
                  <Animated.View
                    style={[
                      styles.writeLine,
                      { width: lineWidth(n), transformOrigin: 'left' },
                      loop(briefWrite, 6000, n * 380, 'linear')
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      </Flat3D>
      <Badge icon={PenLine} style={[styles.over, { position: 'absolute', right: 32, top: 24 }, loop(coinBob, 5000)]} />
      <Chip icon={Smartphone} label="Screenshot" pos={{ left: 0, top: 16 }} struck />
      <Chip icon={FileText} label="Notes app" pos={{ bottom: 24, left: 16 }} delay={0.9} struck />
      <Chip icon={Cloud} label="Cloud" pos={{ bottom: 48, right: 0 }} delay={1.8} struck />
    </Stage>
  )
}

/* ── 6 · Don't lose it ── */
function DontLoseArt() {
  const palette = usePalette()
  const loop = useLoop()
  return (
    <Stage>
      {/* the phone slips away and fades; the paper stays, the way back */}
      <Animated.View style={[styles.dropping, loop(briefDrop, 4500, 0, 'ease-in')]}>
        <TiltedPhone pose={{ scale: 0.8, rx: 28, ry: 18, rz: 14 }}>
          <Text style={[font(800), styles.phoneTitle, { color: palette.foreground }]}>Wallet</Text>
        </TiltedPhone>
      </Animated.View>
      <View style={{ transform: [{ translateX: 40 }, { translateY: 24 }] }}>
        <Flat3D>
          <View style={[styles.paper, styles.keptPaper, { transform: [{ perspective: 700 }, { rotateX: '36deg' }, { rotateZ: '8deg' }] }]}>
            <Text style={[font(700), styles.paperTitle7]}>Recovery phrase</Text>
            <View style={styles.keptGrid}>
              {Array.from({ length: 8 }, (_, n) => (
                <View key={n} style={styles.keptCell}>
                  <View style={[styles.keptLine, { width: lineWidth(n) }]} />
                </View>
              ))}
            </View>
          </View>
        </Flat3D>
      </View>
      <Chip icon={Check} label="Wallet back" tone="good" pos={{ bottom: 16, right: 16 }} delay={0.6} />
    </Stage>
  )
}

/* ── 7 · Ready? ── */
function ReadyArt() {
  const palette = usePalette()
  const loop = useLoop()
  const still = useReducedMotion()
  return (
    <Stage>
      <View style={styles.ready}>
        {!still &&
          [0, 1].map(n => (
            <Animated.View
              key={n}
              style={[styles.pulse, { backgroundColor: palette.gold + '66' }, loop(playPulse, 2400, n * 1200, 'ease-out')]}
            />
          ))}
        <Badge icon={KeyRound} size={96} />
      </View>
      <Chip icon={Check} label="Private" tone="good" pos={{ left: 8, top: 24 }} />
      <Chip icon={Check} label="Written down" tone="good" pos={{ right: 0, top: 64 }} delay={0.9} />
      <Chip icon={Check} label="Never shared" tone="good" pos={{ bottom: 24, left: 24 }} delay={1.8} />
    </Stage>
  )
}

const styles = StyleSheet.create({
  stage: { width: W, height: H, alignItems: 'center', justifyContent: 'center' },
  over: { zIndex: OVER_3D },
  round: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  chip: {
    position: 'absolute',
    zIndex: OVER_3D,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  chipText: { fontSize: 12, lineHeight: 16 },
  strike: { position: 'absolute', left: 0, right: 0, top: 7, height: 2, borderRadius: 1 },
  // the phone's screen
  phoneTitle: { fontSize: 7, lineHeight: 10 },
  bars: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', columnGap: 6, rowGap: 4, paddingTop: 8 },
  barCell: { width: '45%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 2 },
  barNum: { width: 8, textAlign: 'right', fontSize: 5, lineHeight: 7 },
  softText: { opacity: 0.6 },
  bar: { flex: 1, height: 6, borderRadius: 3 },
  eyeRow: { position: 'absolute', left: 0, right: 0, top: '42%', alignItems: 'center' },
  eye: { width: 32, height: 32, boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)' },
  tiny6: { fontSize: 6, lineHeight: 8 },
  tiny55: { fontSize: 5.5, lineHeight: 7 },
  zero: { fontSize: 13, lineHeight: 17, letterSpacing: -0.3 },
  sentList: { marginTop: 8, width: '100%', gap: 4 },
  sentRow: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 4 },
  sentDot: { width: 8, height: 8, borderRadius: 4 },
  // left-[38%] top-[40%]
  coin: { position: 'absolute', zIndex: OVER_3D, left: W * 0.38, top: H * 0.4 },
  stranger: { position: 'absolute', zIndex: OVER_3D, right: 8, top: H * 0.3, alignItems: 'center', gap: 6 },
  mask: { width: 56, height: 56 },
  label: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  labelText: { fontSize: 11, lineHeight: 15 },
  supportRow: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4 },
  supportIcon: { width: 16, height: 16 },
  bubble: { marginTop: 6, alignSelf: 'flex-start', borderRadius: 8, borderTopLeftRadius: 2, paddingHorizontal: 6, paddingVertical: 4 },
  bubbleText: { fontSize: 5.5, lineHeight: 7.5 },
  stamp: { marginTop: 12, borderWidth: 2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  stampText: { fontSize: 9, lineHeight: 12, letterSpacing: 0.9 },
  // the paper
  paper: { backgroundColor: PAPER, borderRadius: 12, boxShadow: '0 18px 40px -14px rgba(0,0,0,0.35)' },
  writePaper: { width: 224, height: 160, padding: 12 },
  paperHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  paperTitle8: { fontSize: 8, lineHeight: 11, color: INK },
  paperTitle7: { fontSize: 7, lineHeight: 10, color: INK },
  writeGrid: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6 },
  writeCell: { width: '45%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  writeNum: { width: 10, textAlign: 'right', fontSize: 6, lineHeight: 8, color: INK + '73' },
  writeTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  writeLine: { height: '100%', borderRadius: 2, backgroundColor: INK + '8c' },
  // under the paper, as in the prototype's document order
  dropping: { position: 'absolute', left: 24, top: 24 },
  keptPaper: { width: 176, height: 112, padding: 10 },
  keptGrid: { marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 4 },
  keptCell: { width: '45%', flexGrow: 1 },
  keptLine: { height: 4, borderRadius: 2, backgroundColor: INK + '4d' },
  ready: { alignItems: 'center', justifyContent: 'center' },
  pulse: { position: 'absolute', width: 96, height: 96, borderRadius: 48 }
})
