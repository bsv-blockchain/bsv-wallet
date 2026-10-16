// The prototype's CoinTube (components/coin-tube.tsx), its loading animation
// for the tour video: a glass tube in perspective filling with Bitcoin SV
// coins, one by one, then the lid comes down with a lock on it; it holds,
// fades and starts again. Each moving part is its own layer over the same
// 220 × 380 drawing, so the prototype's keyframes (globals.css coin-drop,
// lid-drop, lock-pop, tube-round) drive it as they do there. With reduced
// motion it's simply the full tube. With another app icon chosen, the coins
// are that icon's.
import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, css, cubicBezier, useAnimatedProps, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import Svg, { Circle, Defs, Ellipse, G, Image as SvgImage, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import { COIN_IMAGES, useAppIcon } from '../settings/appIcons'
import { EASE_PRESS, useReducedMotion } from '../ui/motion'

const B =
  'M1608,1206c74-51,125-109,125-217c0-172-172-253-276-264c-9-1-32-2-32-2V558h-170l1,165h-114V559H969v163 c-30,1-213,1-213,1v146c0,0,46,0,60,0c57,0,84,36,84,61v9v630c-1,22-17,39-39,41c-26,1-65,0-65,0l-33,166h208v166h173v-166h114 v166h169v-166c0,0,9,0,12,0c196,0,366-116,369-303c2-154-129-243-199-268L1608,1206z M1143,1131V880c23,0,109,0,160,0 c5,0,9,1,13,1c70,3,113,31,136,64c14,20,22,44,22,68c0,17-3,34-9,50c-5,14-12,27-22,39c-8,10-16,18-26,25c-26,19-63,32-114,35 c-1,0-158,1-161,0v-31H1143z M1526,1502c-5,15-13,29-23,42c-8,11-18,19-29,27c-28,20-67,36-124,38c-1,0-205,1-207,1v-305 c25,0,151,1,206,1c5,0,9,1,15,1c75,4,122,33,147,70c15,22,24,47,25,74c-2,18-5,36-10,53l0,0V1502z'

const W = 220
const H = 380
const CX = 110
const TUBE = { rx: 60, ry: 18, top: 96, bottom: 330 }
const COIN = { rx: 50, ry: 15, h: 10 }
const COINS = 16
const STEP = 12
const DROP_GAP = 0.16
const LID_AT = COINS * DROP_GAP + 0.55
const LID_TILT = (TUBE.ry + 1) / (TUBE.rx + 4)
const LOCK_S = 1.7
const CYCLE = LID_AT + 2.3
const sx = 0.026
const sy = sx * (COIN.ry / COIN.rx)
const WOBBLE = [0, 2, -2, 1, -1, 3, -2, 1, 0, -3, 2, -1, 1, -2, 2, 0]

/** cubic-bezier(0.55, 0, 1, 0.45): the fall, picking up speed */
const FALL = cubicBezier(0.55, 0, 1, 0.45)

// each step eases as the prototype's does: falling in, landing out, the little
// bounce back in (globals.css coin-drop, lid-drop)
const keyframes = (unit: number) => ({
  coinDrop: css.keyframes({
    '0%': { transform: [{ translateY: -360 * unit }], opacity: 0, animationTimingFunction: FALL },
    '10%': { opacity: 1 },
    '70%': { transform: [{ translateY: 0 }], animationTimingFunction: 'ease-out' },
    '84%': { transform: [{ translateY: -5 * unit }], animationTimingFunction: 'ease-in' },
    '100%': { transform: [{ translateY: 0 }], opacity: 1 }
  }),
  lidDrop: css.keyframes({
    '0%': { transform: [{ translateY: -110 * unit }, { rotate: '-10deg' }], opacity: 0, animationTimingFunction: FALL },
    '15%': { opacity: 1 },
    '70%': { transform: [{ translateY: 0 }, { rotate: '0deg' }], animationTimingFunction: 'ease-out' },
    '85%': { transform: [{ translateY: -4 * unit }, { rotate: '1deg' }] },
    '100%': { transform: [{ translateY: 0 }, { rotate: '0deg' }], opacity: 1 }
  })
})
const lockPop = css.keyframes({ '0%': { transform: [{ scale: 0 }] }, '70%': { transform: [{ scale: 1.25 }] }, '100%': { transform: [{ scale: 1 }] } })
const round = css.keyframes({ '0%': { opacity: 1 }, '88%': { opacity: 1 }, '100%': { opacity: 0 } })

function Grads() {
  return (
    <Defs>
      <LinearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#9a7000" />
        <Stop offset="0.35" stopColor="#e0aa00" />
        <Stop offset="0.6" stopColor="#f5c62e" />
        <Stop offset="1" stopColor="#8a6400" />
      </LinearGradient>
      <RadialGradient id="face" cx="0.4" cy="0.35" r="0.8">
        <Stop offset="0" stopColor="#ffd84a" />
        <Stop offset="0.7" stopColor="#eab300" />
        <Stop offset="1" stopColor="#c99700" />
      </RadialGradient>
      <LinearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#fff" stopOpacity={0.38} />
        <Stop offset="0.12" stopColor="#fff" stopOpacity={0.55} />
        <Stop offset="0.22" stopColor="#fff" stopOpacity={0.06} />
        <Stop offset="0.78" stopColor="#fff" stopOpacity={0.04} />
        <Stop offset="0.9" stopColor="#fff" stopOpacity={0.3} />
        <Stop offset="1" stopColor="#fff" stopOpacity={0.12} />
      </LinearGradient>
      {/* the ground shadow's soft edge (the prototype blurs it, feGaussianBlur 9) */}
      <RadialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
        <Stop offset="0" stopColor="#000" stopOpacity={0.95} />
        <Stop offset="0.3" stopColor="#000" stopOpacity={0.8} />
        <Stop offset="0.5" stopColor="#000" stopOpacity={0.5} />
        <Stop offset="0.75" stopColor="#000" stopOpacity={0.15} />
        <Stop offset="1" stopColor="#000" stopOpacity={0} />
      </RadialGradient>
      {/* glass on a light ground reads by its edges: a soft shade at each side */}
      <LinearGradient id="edgeShade" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#000" stopOpacity={0.14} />
        <Stop offset="0.07" stopColor="#000" stopOpacity={0.04} />
        <Stop offset="0.2" stopColor="#000" stopOpacity={0} />
        <Stop offset="0.82" stopColor="#000" stopOpacity={0} />
        <Stop offset="0.94" stopColor="#000" stopOpacity={0.07} />
        <Stop offset="1" stopColor="#000" stopOpacity={0.16} />
      </LinearGradient>
      <LinearGradient id="lid" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor="#1d1d1f" />
        <Stop offset="0.4" stopColor="#4a4a50" />
        <Stop offset="1" stopColor="#1d1d1f" />
      </LinearGradient>
    </Defs>
  )
}

function CoinShape({ i, face }: { i: number; face?: number }) {
  const dx = WOBBLE[i % 16]
  const cy = TUBE.bottom - COIN.h - 6 - i * STEP
  return (
    <G transform={`translate(${CX + dx} ${cy})`}>
      <Path d={`M${-COIN.rx} 0 V${COIN.h} A${COIN.rx} ${COIN.ry} 0 0 0 ${COIN.rx} ${COIN.h} V0 Z`} fill="url(#edge)" />
      <Path
        d={`M${-COIN.rx} 0 V${COIN.h} A${COIN.rx} ${COIN.ry} 0 0 0 ${COIN.rx} ${COIN.h} V0`}
        fill="none"
        stroke="#8a6400"
        strokeWidth={0.8}
        strokeDasharray="1.2 2.4"
        opacity={0.5}
      />
      {face ? (
        // the chosen app icon's coin, seen at the same angle
        <SvgImage href={face} x={-COIN.rx} y={-COIN.ry} width={COIN.rx * 2} height={COIN.ry * 2} preserveAspectRatio="none" />
      ) : (
        <>
          <Ellipse rx={COIN.rx} ry={COIN.ry} fill="url(#face)" stroke="#f7cf55" strokeWidth={1.4} />
          <Ellipse rx={COIN.rx - 6} ry={COIN.ry - 2} fill="none" stroke="#c99a00" strokeWidth={0.9} opacity={0.6} />
          <Path d={B} fill="#fff" transform={`translate(${-1250 * sx} ${-1250 * sy}) scale(${sx} ${sy})`} />
        </>
      )}
    </G>
  )
}

/** A layer of the drawing, the size of the whole tube. */
function Layer({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <Svg viewBox={`0 0 ${W} ${H}`} width={width} height={(width * H) / W} style={StyleSheet.absoluteFill}>
      <Grads />
      {children}
    </Svg>
  )
}

export function CoinTube({ width = 112, loop = false, onDark = false }: { width?: number; loop?: boolean; onDark?: boolean }) {
  const still = useReducedMotion()
  // the coins wear the chosen app icon (Settings → App icon)
  const icon = useAppIcon()
  const face = icon === 'classic' || icon === 'wallet' ? undefined : COIN_IMAGES[icon]
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!loop || still) return
    const t = setInterval(() => setN(x => x + 1), CYCLE * 1000)
    return () => clearInterval(t)
  }, [loop, still])
  const unit = width / W
  const k = keyframes(unit)
  const { rx, ry, top, bottom } = TUBE
  const left = CX - rx
  const right = CX + rx
  // a CSS animation style (the keyframes are Reanimated's, the settings the prototype's)
  const anim = (name: object, delay: number, duration: number, easing: unknown = 'ease-out') =>
    (still
      ? null
      : { animationName: name, animationDuration: duration * 1000, animationDelay: delay * 1000, animationFillMode: 'both', animationTimingFunction: easing }) as never

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      // the prototype's rotateX/rotateY would tip half of each layer behind the
      // screen's plane on iOS, where it's hidden: the ellipses carry the perspective
      style={{ width, height: (width * H) / W, transform: [{ rotateZ: '-6deg' }] }}
    >
      <Animated.View key={n} style={[StyleSheet.absoluteFill, loop && !still ? { animationName: round, animationDuration: CYCLE * 1000, animationTimingFunction: 'linear', animationFillMode: 'both' } : null]}>
        {/* the ground shadow, the back wall and floor */}
        <Layer width={width}>
          {/* rx + 18 by ry, blurred: drawn twice the blur wider, fading out */}
          <Ellipse cx={CX} cy={bottom + 22} rx={rx + 18 + 18} ry={ry + 18} fill="url(#shadow)" opacity={onDark ? 0.4 : 0.07} />
          <Path
            d={`M${left} ${top} V${bottom} A${rx} ${ry} 0 0 0 ${right} ${bottom} V${top} A${rx} ${ry} 0 0 0 ${left} ${top} Z`}
            fill="#fff"
            fillOpacity={onDark ? 0.05 : 0.1}
          />
          <Ellipse cx={CX} cy={top} rx={rx} ry={ry} fill={onDark ? '#fff' : '#000'} fillOpacity={0.05} />
        </Layer>
        {/* the coins, dropping in one by one */}
        {Array.from({ length: COINS }, (_, i) => (
          <Animated.View key={i} style={[StyleSheet.absoluteFill, anim(k.coinDrop, i * DROP_GAP, 0.75, 'ease')]}>
            <Layer width={width}>
              <CoinShape i={i} face={face} />
            </Layer>
          </Animated.View>
        ))}
        {/* the glass in front */}
        <Layer width={width}>
          <Path
            d={`M${left} ${top} V${bottom} A${rx} ${ry} 0 0 0 ${right} ${bottom} V${top} A${rx} ${ry} 0 0 1 ${left} ${top} Z`}
            fill="url(#glass)"
          />
          {!onDark && (
            <Path
              d={`M${left} ${top} V${bottom} A${rx} ${ry} 0 0 0 ${right} ${bottom} V${top} A${rx} ${ry} 0 0 1 ${left} ${top} Z`}
              fill="url(#edgeShade)"
            />
          )}
          <Path
            d={`M${left} ${top} V${bottom} A${rx} ${ry} 0 0 0 ${right} ${bottom} V${top}`}
            fill="none"
            stroke={onDark ? '#fff' : '#000'}
            strokeOpacity={onDark ? 0.3 : 0.25}
            strokeWidth={1.6}
          />
          <Ellipse cx={CX} cy={top} rx={rx} ry={ry} fill="none" stroke={onDark ? '#fff' : '#000'} strokeOpacity={onDark ? 0.35 : 0.3} strokeWidth={1.6} />
          <Path d={`M${left + 9} ${top + 16} V${bottom - 8}`} stroke="#fff" strokeOpacity={0.7} strokeWidth={3} strokeLinecap="round" />
        </Layer>
        {/* the lid, then its lock */}
        <Animated.View style={[StyleSheet.absoluteFill, anim(k.lidDrop, LID_AT, 0.7, 'ease')]}>
          <Layer width={width}>
            <Path d={`M${left - 4} ${top - 24} V${top + 2} A${rx + 4} ${ry + 1} 0 0 0 ${right + 4} ${top + 2} V${top - 24} Z`} fill="url(#lid)" />
            <Ellipse cx={CX} cy={top - 24} rx={rx + 4} ry={ry + 1} fill="#3a3a40" stroke="#56565c" strokeWidth={1} />
            <Ellipse cx={CX} cy={top - 24} rx={rx - 10} ry={ry - 5} fill="none" stroke="#1d1d1f" strokeWidth={1.2} opacity={0.6} />
            {/* the lock clicking shut: a ring spreading over the lid */}
            {!still && <LockPing unit={unit} />}
          </Layer>
          <Animated.View
            style={[
              styles.lock,
              { left: (CX - 12 * LOCK_S) * unit, top: (top - 24 - 15 * LOCK_S * LID_TILT) * unit, width: 24 * LOCK_S * unit, height: 24 * LOCK_S * LID_TILT * unit },
              anim(lockPop, LID_AT + 0.45, 0.45, EASE_PRESS)
            ]}
          >
            <Svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="none">
              <Rect x="3" y="11" width="18" height="11" rx="2" fill="#66666e" />
              <Path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="#66666e" strokeWidth={2.6} strokeLinecap="round" />
              <Circle cx="12" cy="16.5" r="1.6" fill="#3a3a40" />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  )
}

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse)
const easeOut = Easing.bezierFn(0, 0, 0.58, 1)

/**
 * @keyframes lock-ping (1.1s ease-out, at LID_AT + 0.7s): from 0.6 to 3.4
 * times its size, in to 0.95 by 12% and out again. Its ellipse grows rather
 * than scales, so the line keeps its width (vector-effect: non-scaling-stroke).
 */
function LockPing({ unit }: { unit: number }) {
  const t = useSharedValue(0)
  useEffect(() => {
    t.value = withDelay((LID_AT + 0.7) * 1000, withTiming(1, { duration: 1100, easing: Easing.linear }))
  }, [t])
  const props = useAnimatedProps(() => {
    const scale = 0.6 + 2.8 * easeOut(t.value)
    const opacity = t.value <= 0 ? 0 : t.value < 0.12 ? 0.95 * easeOut(t.value / 0.12) : 0.95 * (1 - easeOut((t.value - 0.12) / 0.88))
    return { rx: 16 * scale, ry: 16 * LID_TILT * scale, strokeOpacity: opacity }
  })
  return (
    <AnimatedEllipse
      cx={CX}
      cy={TUBE.top - 24}
      rx={16 * 0.6}
      ry={16 * LID_TILT * 0.6}
      fill="none"
      stroke="#8e8e96"
      strokeOpacity={0}
      strokeWidth={1.6 / unit}
      animatedProps={props}
    />
  )
}

const styles = StyleSheet.create({
  lock: { position: 'absolute' }
})
