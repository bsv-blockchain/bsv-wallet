// Small drawing helpers for the prototype's illustrated pieces.
import React from 'react'
import { type ViewStyle, View } from 'react-native'
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg'

let uid = 0
const nextId = (p: string) => `${p}-${++uid}`

/**
 * A blurred ellipse: CSS `rounded-full bg-<color> blur-<n>`. `frame` is the
 * element's own box (before blur); the gradient covers the blurred extent.
 */
export function SoftEllipse({
  frame,
  color,
  opacity,
  blur
}: {
  frame: { left: number; top: number; width: number; height: number }
  color: string
  opacity: number
  blur: number
}) {
  const id = React.useMemo(() => nextId('soft'), [])
  const W = frame.width + blur * 2
  const H = frame.height + blur * 2
  const inner = Math.max(0, (Math.min(frame.width, frame.height) / 2 - blur) / (Math.min(W, H) / 2))
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: frame.left - blur, top: frame.top - blur, width: W, height: H }}>
      <Svg width={W} height={H}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={color} stopOpacity={opacity} />
            <Stop offset={inner} stopColor={color} stopOpacity={opacity} />
            <Stop offset={inner + (1 - inner) * 0.5} stopColor={color} stopOpacity={opacity * 0.5} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={W} height={H} fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

/**
 * zIndex for anything drawn beside a tilted 3D element. iOS depth-sorts a
 * perspective-rotated layer against its flat siblings (React Native maps
 * zIndex to the layer's zPosition there), so overlays must sit above the
 * tilt's deepest point, as they do in the browser by document order.
 */
export const OVER_3D = 200

/** A linear gradient filling its parent: CSS bg-gradient-to-{b,br}. */
export function Gradient({
  stops,
  direction = 'b',
  radius = 0,
  style
}: {
  stops: { offset: number; color: string; opacity: number }[]
  direction?: 'b' | 'br' | 't' | 'r'
  radius?: number
  style?: ViewStyle
}) {
  const id = React.useMemo(() => nextId('grad'), [])
  const [x2, y2] = direction === 'br' ? [1, 1] : direction === 'r' ? [1, 0] : [0, 1]
  const flip = direction === 't'
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: radius, overflow: 'hidden' }, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1={flip ? 1 : 0} x2={x2} y2={flip ? 0 : y2}>
            {stops.map((s, i) => (
              <Stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

/**
 * CSS 3D: where `translateZ(-depth)` lands on screen under `rotateX(a)
 * rotateY(b) rotateZ(c)`, expressed as an offset in the element's own plane.
 * React Native has no preserve-3d, so the prototype's stacked edge layers
 * (its phone and paper thickness) are drawn flat at these offsets inside the
 * rotated view, which projects them to the same place.
 */
export function edgeOffset(rx: number, ry: number, rz: number, depth: number): { x: number; y: number } {
  const r = (d: number) => (d * Math.PI) / 180
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(rx)), Math.sin(r(rx)), Math.cos(r(ry)), Math.sin(r(ry)), Math.cos(r(rz)), Math.sin(r(rz))]
  // M = Rx · Ry · Rz (CSS applies the list right to left to a point)
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
  const mul = (A: number[][], B: number[][]) => A.map((row, i) => B[0].map((_, j) => row.reduce((acc, _v, k) => acc + A[i][k] * B[k][j], 0)))
  const M = mul(mul(Rx, Ry), Rz)
  // screen offset of (0, 0, -depth)
  const tx = M[0][2] * -depth
  const ty = M[1][2] * -depth
  // the in-plane (x, y) that M maps onto the same screen offset
  const a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1]
  const det = a * d - b * c
  return { x: (d * tx - b * ty) / det, y: (-c * tx + a * ty) / det }
}

/** Projects a point in the rotated element's plane (relative to its centre) to the screen, with CSS perspective. */
export function project(rx: number, ry: number, rz: number, perspective: number, px: number, py: number): { x: number; y: number } {
  const r = (d: number) => (d * Math.PI) / 180
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(rx)), Math.sin(r(rx)), Math.cos(r(ry)), Math.sin(r(ry)), Math.cos(r(rz)), Math.sin(r(rz))]
  // Rz, then Ry, then Rx
  let x = px * cz - py * sz
  let y = px * sz + py * cz
  let z = 0
  ;[x, z] = [x * cy + z * sy, -x * sy + z * cy]
  ;[y, z] = [y * cx - z * sx, y * sx + z * cx]
  const k = perspective / (perspective - z)
  return { x: x * k, y: y * k }
}

/** As `project`, for a point lifted `pz` off the element's plane (towards the viewer). */
export function project3(rx: number, ry: number, rz: number, perspective: number, px: number, py: number, pz: number): { x: number; y: number; k: number } {
  const r = (d: number) => (d * Math.PI) / 180
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(rx)), Math.sin(r(rx)), Math.cos(r(ry)), Math.sin(r(ry)), Math.cos(r(rz)), Math.sin(r(rz))]
  let x = px * cz - py * sz
  let y = px * sz + py * cz
  let z = pz
  ;[x, z] = [x * cy + z * sy, -x * sy + z * cy]
  ;[y, z] = [y * cx - z * sx, y * sx + z * cx]
  const k = perspective / (perspective - z)
  return { x: x * k, y: y * k, k }
}

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress, for JS-driven frames. */
export function cubicBezierFn(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (bx(mid) < x) lo = mid
      else hi = mid
    }
    return by((lo + hi) / 2)
  }
}

/**
 * Isolates a 3D-transformed element so it composites flat, in document order,
 * as in the browser. iOS otherwise depth-sorts and intersects a perspective-
 * rotated layer with its flat siblings: glows draw over half the phone and the
 * phone cuts through the chips. The container is rasterised on iOS (and drawn
 * to a hardware texture on Android, which is also cheaper while it animates),
 * with `bleed` points of room for the rotated corners.
 */
export function Flat3D({ bleed = 48, children }: { bleed?: number; children: React.ReactNode }) {
  return (
    <View
      // a real layer: Fabric would otherwise flatten this layout-only view away
      collapsable={false}
      shouldRasterizeIOS
      renderToHardwareTextureAndroid
      pointerEvents="box-none"
      style={{ padding: bleed, margin: -bleed, alignItems: 'center', justifyContent: 'center' }}
    >
      {children}
    </View>
  )
}
