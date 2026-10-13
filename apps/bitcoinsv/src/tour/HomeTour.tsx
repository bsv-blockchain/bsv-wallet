// The Home tour (the prototype's components/home-tour.tsx): the screen dims,
// the things being explained stay lit, and each gets a white hand-drawn
// arrow and a hand-written label. Tap anywhere (or Next) for the next
// screen, swipe back or on, Skip ends it; the last screen's "Learn more"
// opens the tour video.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import Animated, { Easing, cubicBezier, useAnimatedProps, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, Mask, Path, Rect } from 'react-native-svg'
import { font, handwriting } from '../theme'
import { enter, tourHintIn, useReducedMotion } from '../ui/motion'
import { PressScale } from '../ui/PressScale'
import { WalletCard } from '../home/WalletSwitcher'
import { measureTarget, type Rect as Box, type TourTarget } from './targets'

/** Tailwind's default transition curve */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/**
 * One label: what it points at, what to call it (two words at most), and
 * where the label sits relative to the element's bottom centre (or its top,
 * `above`, with the arrow pointing down).
 */
interface Mark {
  target: TourTarget
  label: string
  dx?: number
  dy: number
  above?: boolean
}

/** The Home tour, a screen at a time: top bar, then the tiles, then lists. */
const STEPS: Mark[][] = [
  [
    { target: 'wallets', label: 'Your wallets', dx: 18, dy: 150 },
    { target: 'signin', label: 'Sign in', dx: 10, dy: 62 },
    { target: 'search', label: 'Find anything', dx: -18, dy: 96 },
    // well left of Settings, so its arrow passes beside that label, not through it
    { target: 'help', label: 'Get help', dx: -72, dy: 150 },
    { target: 'settings', label: 'Settings', dx: -16, dy: 62 }
    // and the wallet list open under them, its two ways to add a wallet lit (WalletPeek)
  ],
  // Top up (Buy) isn't in the product yet: the prototype's label without it
  [{ target: 'actions', label: 'Pay & get paid', dy: 80 }],
  [
    { target: 'activity', label: 'Search & filter\npayments', dx: 30, dy: 118, above: true },
    { target: 'contacts', label: 'Your people', dx: -64, dy: 64, above: true }
  ]
]

/**
 * The screen dimmed, with a rounded hole (6pt of room) over each element
 * being explained. A mask, as the prototype's: holes that overlap (the wallet
 * list's two adjacent rows) open as one, where an even-odd path would fill
 * their overlap back in.
 */
function Dim({ width, height, marks }: { width: number; height: number; marks: { rect: Box }[] }) {
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <Mask id="tour-holes" x="0" y="0" width={width} height={height} maskUnits="userSpaceOnUse">
          <Rect x="0" y="0" width={width} height={height} fill="#ffffff" />
          {marks.map(({ rect }, i) => {
            const h = rect.height + 12
            return (
              <Rect key={i} x={rect.x - 6} y={rect.y - 6} width={rect.width + 12} height={h} rx={Math.min(22, h / 2)} fill="#000000" />
            )
          })}
        </Mask>
      </Defs>
      <Rect x="0" y="0" width={width} height={height} fill="#000000" fillOpacity={0.78} mask="url(#tour-holes)" />
    </Svg>
  )
}

/** Room kept between a label's centre and the screen edge. */
const EDGE = 64

type Placed = Mark & { rect: Box }

export function HomeTour({
  open,
  onSkip,
  onLearnMore,
  scrollToTop
}: {
  open: boolean
  onSkip: () => void
  onLearnMore: () => void
  /** Home back at the top, so the bar and tiles are where the labels expect */
  scrollToTop?: () => void
}) {
  const { width: W, height: H } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  // the first screen's wallet list, and where its two add-a-wallet rows are
  const [peekHoles, setPeekHoles] = useState<Box[]>([])
  // only the screens whose things are on Home today (activity and contacts come later)
  const [steps, setSteps] = useState<Placed[][]>([])
  const [step, setStep] = useState(0)

  const measure = useCallback(async () => {
    const placed = await Promise.all(
      STEPS.map(async s => (await Promise.all(s.map(async m => ({ ...m, rect: await measureTarget(m.target) })))).filter((m): m is Placed => !!m.rect))
    )
    setSteps(placed.filter(s => s.length > 0))
  }, [])

  useEffect(() => {
    if (!open) return
    setStep(0)
    setPeekHoles([])
    scrollToTop?.()
    // measured once the scroll back to the top has been drawn
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => void measure())
    })
    return () => cancelAnimationFrame(raf)
  }, [open, measure, scrollToTop])

  const last = step === steps.length - 1
  const finish = () => onSkip()
  const next = () => (last ? onLearnMore() : setStep(s => s + 1))
  const back = () => step > 0 && setStep(s => s - 1)

  // a swipe right goes back, left goes on; a tap anywhere also goes on
  const swipeFrom = useRef<number | null>(null)
  const marks = steps[step] ?? []
  // the first screen (the top bar) shows the wallet list open under it
  const wallets = step === 0 ? marks.find(m => m.target === 'wallets') : undefined
  const holes = wallets ? [...marks, ...peekHoles.map(rect => ({ rect }))] : marks

  return (
    // animate-in fade-in duration-300; gone at once when it ends
    <Modal transparent visible={open && steps.length > 0} animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={finish}>
      <Animated.View style={[StyleSheet.absoluteFill, still ? null : enter({ duration: 300 })]}>
        {/* not one accessible element: its labels, Skip and Next are each reachable */}
        <Pressable
          accessible={false}
          accessibilityViewIsModal
          accessibilityLabel="Tour of the Home screen"
          style={StyleSheet.absoluteFill}
          onPressIn={e => (swipeFrom.current = e.nativeEvent.pageX)}
          onPress={e => {
            const from = swipeFrom.current
            swipeFrom.current = null
            const dx = from == null ? 0 : e.nativeEvent.pageX - from
            if (Math.abs(dx) >= 50) {
              if (dx > 0) back()
              else next()
            } else next()
          }}
        >
          {/* under the dim: the wallet list, peeking out below the bar's labels */}
          {wallets && <WalletPeek anchor={wallets.rect} onRows={setPeekHoles} />}

          {/* the dim, with a hole over each element being explained */}
          <Dim width={W} height={H} marks={holes} />

          {/* one hint at a time: its label, then its line drawing in to the element */}
          <View key={step} style={StyleSheet.absoluteFill} pointerEvents="none">
            {marks
              .filter(m => m.label)
              .map((m, i) => {
                const delay = 150 + i * 350
                const tx = m.rect.x + m.rect.width / 2
                const ty = m.above ? m.rect.y - 10 : m.rect.y + m.rect.height + 10
                const lx = Math.min(Math.max(tx + (m.dx ?? 0), EDGE), W - EDGE)
                const ly = m.above ? m.rect.y - m.dy : m.rect.y + m.rect.height + m.dy
                // the arrow leaves from just above the label (below it, pointing down)
                const lines = m.label.split('\n').length
                const from = m.above ? ly + 6 + lines * 14 : ly - 16 - lines * 14
                return (
                  <React.Fragment key={m.target}>
                    <Arrow from={[lx, from]} to={[tx, ty]} delay={delay + 100} width={W} height={H} />
                    <HintLabel x={lx} y={ly} delay={delay} text={m.label} />
                  </React.Fragment>
                )
              })}
          </View>

          {/* where you are, and the way out */}
          <View style={[styles.bar, { bottom: Math.max(24, insets.bottom + 8) }]}>
            <View style={styles.left}>
              {step > 0 && (
                <Pressable onPress={back} accessibilityRole="button" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
                  <Text style={[font(600), styles.barText]}>Back</Text>
                </Pressable>
              )}
              <Pressable onPress={finish} accessibilityRole="button" style={styles.skip}>
                <Text style={[font(600), styles.barText, styles.dim]}>Skip</Text>
              </Pressable>
            </View>
            <View style={styles.dots}>
              {steps.map((_, i) => (
                <Pressable
                  key={i}
                  onPress={() => setStep(i)}
                  accessibilityRole="button"
                  accessibilityLabel={`Step ${i + 1} of ${steps.length}`}
                  accessibilityState={{ selected: i === step }}
                  style={styles.dotHit}
                >
                  {/* transition-all: the current dot widening over 150ms */}
                  <Animated.View
                    style={[
                      styles.dot,
                      i === step ? styles.dotOn : styles.dotOff,
                      { transitionProperty: ['width', 'backgroundColor'], transitionDuration: 150, transitionTimingFunction: EASE }
                    ]}
                  />
                </Pressable>
              ))}
            </View>
            <View style={styles.right}>
              <PressScale onPress={next} accessibilityRole="button" style={styles.next}>
                <Text style={[font(600), styles.barText, styles.nextText]}>{last ? 'Learn more' : 'Next'}</Text>
              </PressScale>
            </View>
          </View>
        </Pressable>
      </Animated.View>
    </Modal>
  )
}

/**
 * The wallet switcher's card, open for the tour's first screen (the
 * prototype's WalletSwitcher peek): 190pt below the avatar, out of the way of
 * the bar's labels, and not in use. Its Import and Create rows are lit.
 */
function WalletPeek({ anchor, onRows }: { anchor: Box; onRows: (rows: Box[]) => void }) {
  const importRow = useRef<View>(null)
  const createRow = useRef<View>(null)
  useEffect(() => {
    // once its 100ms entrance is over, so the rows are measured at rest
    const t = setTimeout(async () => {
      const rows = await Promise.all(
        [importRow.current, createRow.current].map(
          el =>
            new Promise<Box | null>(resolve =>
              el ? el.measureInWindow((x, y, width, height) => resolve(width > 0 && height > 0 ? { x, y, width, height } : null)) : resolve(null)
            )
        )
      )
      onRows(rows.filter((r): r is Box => !!r))
    }, 350)
    return () => clearTimeout(t)
  }, [anchor.x, anchor.y, onRows])
  const none = () => {}
  return (
    <WalletCard
      peek
      top={anchor.y + anchor.height + 190}
      left={anchor.x - 8}
      onClose={none}
      onImport={none}
      onCreate={none}
      importRef={importRow}
      createRef={createRow}
    />
  )
}

function HintLabel({ x, y, delay, text }: { x: number; y: number; delay: number; text: string }) {
  const still = useReducedMotion()
  return (
    <View style={[styles.labelAnchor, { left: x, top: y }]}>
      <Animated.Text
        style={[
          handwriting(700),
          styles.label,
          still ? null : { animationName: tourHintIn, animationDuration: 350, animationDelay: delay, animationTimingFunction: 'ease-out', animationFillMode: 'both' }
        ]}
      >
        {text}
      </Animated.Text>
    </View>
  )
}

const AnimatedPath = Animated.createAnimatedComponent(Path)

/** A hand-drawn arrow: a gentle curve with an open head at `to`, drawing itself in. */
function Arrow({ from, to, delay, width, height }: { from: [number, number]; to: [number, number]; delay: number; width: number; height: number }) {
  const still = useReducedMotion()
  const [x1, y1] = from
  const [x2, y2] = to
  // bend: leave the label heading up, arrive from the side it came from
  const cx = x1 + (x2 - x1) * 0.15
  const cy = y2 + (y1 - y2) * 0.35
  const angle = Math.atan2(y2 - cy, x2 - cx)
  const head = (a: number) => [x2 - 11 * Math.cos(angle + a), y2 - 11 * Math.sin(angle + a)]
  const [ax, ay] = head(0.5)
  const [bx, by] = head(-0.5)
  // the curve's length, for drawing it in with a dash
  const length = useMemo(() => {
    let len = 0
    let px = x1
    let py = y1
    for (let i = 1; i <= 24; i++) {
      const t = i / 24
      const qx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2
      const qy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2
      len += Math.hypot(qx - px, qy - py)
      px = qx
      py = qy
    }
    return len
  }, [x1, y1, cx, cy, x2, y2])

  const drawn = useSharedValue(still ? 1 : 0)
  useEffect(() => {
    if (still) return
    drawn.value = withDelay(delay, withTiming(1, { duration: 450, easing: Easing.out(Easing.ease) }))
  }, [delay, still, drawn])
  const lineProps = useAnimatedProps(() => ({ strokeDashoffset: length * (1 - drawn.value) }))

  return (
    <>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <AnimatedPath
          d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
          fill="none"
          stroke="white"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={[length, length]}
          animatedProps={lineProps}
        />
      </Svg>
      {/* the head: tour-hint-in, rising 4pt as it fades in, once the line is there */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          still ? null : { animationName: tourHintIn, animationDuration: 350, animationDelay: delay + 400, animationTimingFunction: 'ease-out', animationFillMode: 'both' }
        ]}
      >
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Path
            d={`M ${ax} ${ay} L ${x2} ${y2} L ${bx} ${by}`}
            fill="none"
            stroke="white"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>
    </>
  )
}

const styles = StyleSheet.create({
  labelAnchor: { position: 'absolute', width: 0, height: 0, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  label: { position: 'absolute', width: 240, textAlign: 'center', fontSize: 28, lineHeight: 27, color: '#ffffff' },
  bar: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', alignItems: 'center', gap: 8 },
  left: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  right: { flex: 1, alignItems: 'flex-end' },
  back: {
    height: 44,
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)'
  },
  skip: { height: 44, justifyContent: 'center', paddingHorizontal: 12 },
  barText: { fontSize: 15, lineHeight: 20, color: '#ffffff' },
  dim: { color: 'rgba(255,255,255,0.75)' },
  dots: { flexDirection: 'row', alignItems: 'center' },
  dotHit: { height: 36, justifyContent: 'center', paddingHorizontal: 4 },
  dot: { height: 8, borderRadius: 4 },
  dotOn: { width: 20, backgroundColor: '#ffffff' },
  dotOff: { width: 8, backgroundColor: 'rgba(255,255,255,0.35)' },
  next: { height: 44, justifyContent: 'center', borderRadius: 999, paddingHorizontal: 24, backgroundColor: '#ffffff' },
  nextText: { color: '#161618' },
  pressed: { transform: [{ scale: 0.97 }] }
})

