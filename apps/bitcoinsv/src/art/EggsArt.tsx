// Welcome screen 2, "More bang for your buck" (the prototype's EggsArt in
// components/why-art.tsx): a box of six eggs, tilted like the phone. The lid
// swings open, the eggs hop in turn, the price hangs on a swinging tag. Paid
// by card, the sixth egg goes (the fee eats it) and the price counts up to
// $6.47; paid with BitcoinSV it comes back, golden, and the price returns.
//
// The prototype builds this in CSS 3D (preserve-3d, translateZ, a lid hinged
// past 90°, eggs counter-rotated upright inside the tilted tray). React Native
// has none of that, so: the tray is a real perspective-rotated view; each egg
// is drawn upright at its cup's projected position, its Z hop turned into the
// matching screen movement; the lid is a projected quad driven through the
// prototype's easing curve.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import Svg, { Circle, Defs, G, Path, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg'
import { font, useIsDark, usePalette } from '../theme'
import { enter, tagSwing, useReducedMotion } from '../ui/motion'
import { Flat3D, OVER_3D, SoftEllipse, cubicBezierFn, edgeOffset, project3 } from '../ui/Soft'

const RX = 52
const RZ = -14
const PERSPECTIVE = 800
const BOX_W = 288
const BOX_H = 224
const TRAY_W = 208
const TRAY_H = 96
/** the tray's centre in the box: flex-centred, pushed down by mt-8 */
const TRAY_CX = BOX_W / 2
const TRAY_CY = BOX_H / 2 + 16
/** which egg card fees take (and BitcoinSV gives back): front row, right */
const SIXTH = 5
const HOP_DELAYS = [0, 0.3, 0.6, 0.45, 0.15, 0.75]

// grid-cols-3 grid-rows-2 gap-1 p-1.5
const CUP_W = (TRAY_W - 12 - 8) / 3
const CUP_H = (TRAY_H - 12 - 4) / 2
const cupCentre = (i: number) => ({ x: 6 + (i % 3) * (CUP_W + 4) + CUP_W / 2, y: 6 + Math.floor(i / 3) * (CUP_H + 4) + CUP_H / 2 })

/** Screen point of a spot on the tray (tray-local coordinates), lifted `z` off it. */
const onTray = (x: number, y: number, z: number) => {
  const p = project3(RX, 0, RZ, PERSPECTIVE, x - TRAY_W / 2, y - TRAY_H / 2, z)
  return { x: TRAY_CX + p.x, y: TRAY_CY + p.y, k: p.k }
}

/**
 * @keyframes egg-hop: translateZ 2 → 6 → 2.5 → 3.5 → 2, as screen movement.
 * The tray's normal projects to (0, −sin 52°): every px of Z lifts the egg
 * that much up the screen.
 */
const LIFT = Math.sin((RX * Math.PI) / 180)
const eggHop = css.keyframes({
  '0%': { transform: [{ translateY: 0 }] },
  '22%': { transform: [{ translateY: -(6 - 2) * LIFT }] },
  '36%': { transform: [{ translateY: -(2.5 - 2) * LIFT }] },
  '42%': { transform: [{ translateY: -(3.5 - 2) * LIFT }] },
  '45%': { transform: [{ translateY: 0 }] },
  '100%': { transform: [{ translateY: 0 }] }
})

// border-radius: 50% / 60% 60% 42% 42% on a 32×42 egg (CSS scales the
// vertical radii down to fit: 42 / 42.8)
const EGG_W = 32
const EGG_H = 42
const TOP_R = EGG_H * 0.6 * (EGG_H / (EGG_H * 1.02))
const EGG_PATH = `M0,${TOP_R} A${EGG_W / 2},${TOP_R} 0 0 1 ${EGG_W},${TOP_R} A${EGG_W / 2},${EGG_H - TOP_R} 0 0 1 0,${TOP_R} Z`

const WHITE = ['#fffdf6', '#f6e8cc', '#e3cc9f', '#c9ae7c']
const GOLD = ['#fff6c9', '#ffd34d', '#eab300', '#a87a00']

function Egg({ id, colors }: { id: string; colors: string[] }) {
  return (
    <Svg width={EGG_W} height={EGG_H} style={StyleSheet.absoluteFill}>
      <Defs>
        {/* radial-gradient(ellipse at 35% 28%, …) */}
        <RadialGradient id={`${id}-fill`} cx="35%" cy="28%" rx="92%" ry="102%" fx="35%" fy="28%">
          <Stop offset="0" stopColor={colors[0]} />
          <Stop offset={colors === GOLD ? 0.35 : 0.38} stopColor={colors[1]} />
          <Stop offset={colors === GOLD ? 0.72 : 0.78} stopColor={colors[2]} />
          <Stop offset="1" stopColor={colors[3]} />
        </RadialGradient>
        {/* inset -3px -4px 6px: shade along the lower right */}
        <RadialGradient id={`${id}-shade`} cx="38%" cy="34%" rx="70%" ry="70%">
          <Stop offset="0.72" stopColor="#785028" stopOpacity={0} />
          <Stop offset="1" stopColor="#785028" stopOpacity={colors === GOLD ? 0.35 : 0.25} />
        </RadialGradient>
      </Defs>
      <Path d={EGG_PATH} fill={`url(#${id}-fill)`} />
      <Path d={EGG_PATH} fill={`url(#${id}-shade)`} />
    </Svg>
  )
}

/** Moulded pulp: warm grey-beige with a faint fibre speckle. */
function Pulp({ id, width, height, radius }: { id: string; width: number; height: number; radius: number }) {
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id={`${id}-a`} width={5} height={5} patternUnits="userSpaceOnUse">
          <Circle cx={0.8} cy={0.8} r={0.9} fill="rgba(90,70,40,0.10)" />
        </Pattern>
        <Pattern id={`${id}-b`} x={2} y={3} width={7} height={7} patternUnits="userSpaceOnUse">
          <Circle cx={0.8} cy={0.8} r={0.9} fill="rgba(255,255,255,0.18)" />
        </Pattern>
      </Defs>
      <Rect width={width} height={height} rx={radius} fill="#cbbfa6" />
      <Rect width={width} height={height} rx={radius} fill={`url(#${id}-a)`} />
      <Rect width={width} height={height} rx={radius} fill={`url(#${id}-b)`} />
    </Svg>
  )
}

const LID_EASE = cubicBezierFn(0.34, 1.3, 0.64, 1)

/** The lid's opening angle: lid-open, 1s cubic-bezier(0.34,1.3,0.64,1), 0.3s delay. */
function useLidAngle(still: boolean): number {
  const [t, setT] = useState(still ? 1 : 0)
  useEffect(() => {
    if (still) return
    const start = Date.now() + 300
    let raf = 0
    const tick = () => {
      const p = Math.min(1, Math.max(0, (Date.now() - start) / 1000))
      setT(p)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [still])
  return LID_EASE(t)
}

/** The lid, hinged at the back edge, as an affine-mapped group in box coordinates. */
function Lid({ progress, z }: { progress: number; z: number }) {
  // from translateZ(14px) rotateX(0) to rotateX(112deg)
  const theta = (112 * progress * Math.PI) / 180
  const lift = 14 * (1 - progress)
  const corner = (u: number, v: number) => onTray(u, v * Math.cos(theta), lift + v * Math.sin(theta))
  const o = corner(0, 0)
  const ux = corner(TRAY_W, 0)
  const vy = corner(0, TRAY_H)
  // affine: (u, v) → o + u·(ux − o)/W + v·(vy − o)/H
  const a = (ux.x - o.x) / TRAY_W
  const b = (ux.y - o.y) / TRAY_W
  const c = (vy.x - o.x) / TRAY_H
  const d = (vy.y - o.y) / TRAY_H
  const cellW = (TRAY_W - 16 - 12) / 3
  const cellH = (TRAY_H - 16 - 6) / 2
  return (
    <Svg width={BOX_W} height={BOX_H} style={[StyleSheet.absoluteFill, { zIndex: z }]} pointerEvents="none">
      <Defs>
        <Pattern id="lid-a" width={5} height={5} patternUnits="userSpaceOnUse">
          <Circle cx={0.8} cy={0.8} r={0.9} fill="rgba(90,70,40,0.10)" />
        </Pattern>
        <RadialGradient id="lid-dome" cx="50%" cy="45%" rx="50%" ry="50%">
          <Stop offset="0" stopColor="#b3a589" />
          <Stop offset="0.6" stopColor="#c8bba1" />
          <Stop offset="0.72" stopColor="#c8bba1" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <G matrix={[a, b, c, d, o.x, o.y]}>
        <Rect width={TRAY_W} height={TRAY_H} rx={16} fill="#cbbfa6" />
        <Rect width={TRAY_W} height={TRAY_H} rx={16} fill="url(#lid-a)" />
        {/* inset 0 0 0 2px rgba(120,100,70,0.25) */}
        <Rect x={1} y={1} width={TRAY_W - 2} height={TRAY_H - 2} rx={15} fill="none" stroke="rgba(120,100,70,0.25)" strokeWidth={2} />
        {Array.from({ length: 6 }, (_, i) => (
          <Rect
            key={i}
            x={8 + (i % 3) * (cellW + 6)}
            y={8 + Math.floor(i / 3) * (cellH + 6)}
            width={cellW}
            height={cellH}
            rx={cellW * 0.45}
            ry={cellH * 0.45}
            fill="url(#lid-dome)"
          />
        ))}
        <Rect x={12} y={TRAY_H - 6} width={TRAY_W - 24} height={6} rx={3} fill="#b9ab90" />
      </G>
    </Svg>
  )
}

export function EggsArt({ phase }: { phase: 'card' | 'bsv' }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const lid = useLidAngle(still)
  const lidBehind = lid * 112 > 90
  const eggs = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => {
        const c = cupCentre(i)
        // the egg's foot (transform-origin 50% 100%), 2px up at rest
        const foot = onTray(c.x, c.y + 9, 2)
        return { i, foot }
      }),
    []
  )
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SoftEllipse frame={{ left: 40, top: 40, width: 208, height: 144 }} color={palette.gold} opacity={0.25} blur={40} />
      <SoftEllipse frame={{ left: 48, top: 168, width: 192, height: 24 }} color="#000000" opacity={dark ? 0.6 : 0.25} blur={24} />

      {lidBehind && <Lid progress={lid} z={0} />}

      {/* the tray */}
      <View style={styles.trayHolder} pointerEvents="none">
        <Flat3D>
        <View style={styles.tray}>
          {Array.from({ length: 14 }, (_, i) => {
            const o = edgeOffset(RX, 0, RZ, (i + 1) * 1.1)
            return (
              <View
                key={i}
                style={[styles.trayLayer, { backgroundColor: i < 3 ? '#b7aa90' : '#a39679', transform: [{ translateX: o.x }, { translateY: o.y }] }]}
              />
            )
          }).reverse()}
          <View style={styles.trayLayer}>
            <Pulp id="tray" width={TRAY_W} height={TRAY_H} radius={16} />
            {Array.from({ length: 6 }, (_, i) => {
              const c = cupCentre(i)
              return (
                <View
                  key={i}
                  style={[
                    styles.cup,
                    {
                      left: c.x - CUP_W / 2,
                      top: c.y - CUP_H / 2,
                      boxShadow: 'inset 0 4px 7px rgba(60,45,20,0.35), 0 1px 0 rgba(255,255,255,0.35)'
                    }
                  ]}
                >
                  <Svg width={CUP_W} height={CUP_H}>
                    <Defs>
                      <RadialGradient id={`cup-${i}`} cx="50%" cy="42%" rx="62%" ry="62%">
                        <Stop offset="0" stopColor="#94866a" />
                        <Stop offset="0.55" stopColor="#ad9f83" />
                        <Stop offset="1" stopColor="#c3b69c" />
                      </RadialGradient>
                    </Defs>
                    <Rect width={CUP_W} height={CUP_H} rx={CUP_H / 2} fill={`url(#cup-${i})`} />
                  </Svg>
                </View>
              )
            })}
            {/* the cone posts between the cups (translateZ(5px)) */}
            {[1 / 3, 2 / 3].map(x => {
              const o = edgeOffset(RX, 0, RZ, -5)
              return (
                <View
                  key={x}
                  style={[
                    styles.post,
                    { left: x * TRAY_W - 7 + o.x, top: TRAY_H / 2 - 7 + o.y, boxShadow: '0 2px 3px rgba(60,45,20,0.35)' }
                  ]}
                >
                  <Svg width={14} height={14}>
                    <Defs>
                      <RadialGradient id={`post-${x}`} cx="40%" cy="35%" rx="70%" ry="70%">
                        <Stop offset="0" stopColor="#ddd2bc" />
                        <Stop offset="1" stopColor="#b6a98e" />
                      </RadialGradient>
                    </Defs>
                    <Circle cx={7} cy={7} r={7} fill={`url(#post-${x})`} />
                  </Svg>
                </View>
              )
            })}
          </View>
        </View>
        </Flat3D>
      </View>

      {/* the eggs, stood upright on their cups, back row first */}
      {eggs.map(({ i, foot }) => {
        const sixth = i === SIXTH
        const golden = sixth && phase === 'bsv'
        const w = EGG_W * foot.k
        const h = EGG_H * foot.k
        return (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              { position: 'absolute', zIndex: OVER_3D + i, left: foot.x - w / 2, top: foot.y - h, width: w, height: h },
              still
                ? null
                : {
                    animationName: eggHop,
                    animationDuration: 2800,
                    animationDelay: (1.1 + HOP_DELAYS[i]) * 1000,
                    animationIterationCount: 'infinite',
                    animationTimingFunction: 'ease-in-out'
                  }
            ]}
          >
            <Animated.View
              style={{
                width: EGG_W,
                height: EGG_H,
                transform: [{ scale: foot.k }],
                transformOrigin: '50% 100%',
                // the sixth egg: the one card fees eat
                opacity: sixth && phase === 'card' ? 0 : 1,
                transitionProperty: 'opacity',
                transitionDuration: 500
              }}
            >
              {/* 0 3px 4px rgba(0,0,0,0.25), or the golden glow */}
              <View
                style={[
                  styles.eggShadow,
                  { boxShadow: golden ? '0 0 7px 2px rgba(255,200,40,0.8)' : '0 3px 4px rgba(0,0,0,0.25)' }
                ]}
              />
              <Egg id={`egg-${i}-white`} colors={WHITE} />
              {sixth && (
                <Animated.View style={[StyleSheet.absoluteFill, { opacity: golden ? 1 : 0, transitionProperty: 'opacity', transitionDuration: 500 }]}>
                  <Egg id={`egg-${i}-gold`} colors={GOLD} />
                </Animated.View>
              )}
            </Animated.View>
          </Animated.View>
        )
      })}

      {!lidBehind && <Lid progress={lid} z={OVER_3D + 10} />}

      {/* how this box is being paid for, swapping with the cycle */}
      <View style={styles.paidByRow} pointerEvents="none">
      <Animated.View
        key={phase}
        style={[
          styles.paidBy,
          { backgroundColor: phase === 'card' ? palette.destructive : palette.gold },
          still ? null : enter({ translateY: 4, duration: 300 })
        ]}
      >
        <Text style={[font(700), styles.paidByText, { color: phase === 'card' ? '#fff' : palette.goldForeground }]}>
          {phase === 'card' ? 'Paid by card' : 'Paid with Bitcoin SV'}
        </Text>
      </Animated.View>
      </View>

      {/* the price, hanging on a string and swinging gently */}
      <Animated.View style={[styles.tagHolder, still ? null : enter({ translateY: -16, duration: 700, delay: 700 })]}>
        <View style={[styles.string, { backgroundColor: palette.foreground, opacity: 0.3 }]} />
        <Animated.View
          style={[
            styles.tag,
            { backgroundColor: palette.card, boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}` },
            still ? null : { transformOrigin: 'top', animationName: tagSwing, animationDuration: 3000, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }
          ]}
        >
          <View style={[styles.tagHole, { backgroundColor: palette.border }]} />
          <PriceTag phase={phase} />
        </Animated.View>
      </Animated.View>
    </View>
  )
}

/** $6.00, counting up to $6.47 when paid by card (the cents turning red), back down with BitcoinSV. */
function PriceTag({ phase }: { phase: 'card' | 'bsv' }) {
  const palette = usePalette()
  const target = phase === 'card' ? 6.47 : 6
  const [shown, setShown] = useState(6)
  const from = useRef(6)
  useEffect(() => {
    const start = Date.now()
    const begin = from.current
    let raf = 0
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / 900)
      const v = begin + (target - begin) * (1 - Math.pow(1 - t, 3))
      from.current = v
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  const [dollars, cents] = shown.toFixed(2).split('.')
  return (
    // the cents in their own text, so their colour can ease (transition-colors duration-300)
    <View style={styles.priceRow}>
      <Text style={[font(800), styles.price, { color: palette.foreground }]}>${dollars}.</Text>
      <Animated.Text
        style={[
          font(800),
          styles.price,
          { color: phase === 'card' ? palette.destructive : palette.foreground },
          { transitionProperty: 'color', transitionDuration: 300, transitionTimingFunction: cubicBezier(0.4, 0, 0.2, 1) }
        ]}
      >
        {cents}
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { width: BOX_W, height: BOX_H },
  trayHolder: { position: 'absolute', zIndex: 1, left: TRAY_CX - TRAY_W / 2, top: TRAY_CY - TRAY_H / 2, width: TRAY_W, height: TRAY_H },
  tray: { width: TRAY_W, height: TRAY_H, transform: [{ perspective: PERSPECTIVE }, { rotateX: `${RX}deg` }, { rotateZ: `${RZ}deg` }] },
  trayLayer: { ...StyleSheet.absoluteFill, borderRadius: 16, overflow: 'hidden' },
  cup: { position: 'absolute', width: CUP_W, height: CUP_H, borderRadius: CUP_H / 2, overflow: 'hidden' },
  post: { position: 'absolute', width: 14, height: 14, borderRadius: 7 },
  eggShadow: { ...StyleSheet.absoluteFill, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  paidByRow: { position: 'absolute', zIndex: OVER_3D + 20, left: 0, right: 0, bottom: 0, alignItems: 'center' },
  paidBy: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)'
  },
  paidByText: { fontSize: 12, lineHeight: 16 },
  tagHolder: { position: 'absolute', zIndex: OVER_3D + 20, right: 16, top: 8, alignItems: 'center' },
  string: { height: 20, width: 1 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  tagHole: { width: 6, height: 6, borderRadius: 3 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline' },
  price: { fontSize: 14, lineHeight: 20, fontVariant: ['tabular-nums'] }
})
