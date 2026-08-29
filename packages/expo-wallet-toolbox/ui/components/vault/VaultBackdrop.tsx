import React from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'

/**
 * Isometric blueprint of a security key with a vault wheel on it, sat behind
 * the setup screen's copy.
 *
 * Replaces the 80pt badge that used to sit above the headline: at that size the
 * safe glyph read as a generic settings icon, so the screen's one chance to say
 * what this feature is was spent on something the eye skipped.
 *
 * The subject is both halves of the idea in one object — the key you hold, and
 * the vault it opens. A plain vault door was drawn first and said only half of
 * it: the hardware requirement is the part a user needs to see before tapping
 * "Set up vault".
 *
 * Geometry is real rather than faked. Every point is a 3D coordinate pushed
 * through a true isometric projection, so circles come out as correctly-tilted
 * ellipses, extrusions share one set of axes, and the vertical edges of each
 * solid land on actual silhouette points. An earlier version skewed a flat
 * drawing instead; the ellipses were wrong in a way that read as a smudged logo.
 *
 * The dashed scaffold is what makes it read as a technical drawing rather than
 * an icon, and it deliberately runs off the edges: a drawing that fits entirely
 * inside its box reads as a picture pasted on the background rather than as the
 * background.
 */

/* ---------------------------------------------------------------- projection */

const COS30 = Math.sqrt(3) / 2
const SIN30 = 0.5

interface P3 {
  /** Across the key's width. */
  x: number
  /** Up. */
  y: number
  /** Along the key's length — +z runs toward the USB plug, screen lower-left. */
  z: number
}
interface P2 {
  x: number
  y: number
}

function iso(p: P3): P2 {
  return { x: (p.x - p.z) * COS30, y: (p.x + p.z) * SIN30 - p.y }
}

const SEGMENTS = 64

/** Ring in the horizontal plane — every round feature here lies flat on the key. */
function ringY(atY: number, r: number, ox = 0, oz = 0): P3[] {
  return Array.from({ length: SEGMENTS }, (_, i) => {
    const a = (i / SEGMENTS) * Math.PI * 2
    return { x: ox + r * Math.cos(a), y: atY, z: oz + r * Math.sin(a) }
  })
}

/** Rounded rectangle lying flat — the key's body, its contact pad, its plug. */
function roundedRectY(
  atY: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  r: number
): P3[] {
  const STEP = 8
  const corners: [number, number, number][] = [
    [x1 - r, z1 - r, 0],
    [x0 + r, z1 - r, 90],
    [x0 + r, z0 + r, 180],
    [x1 - r, z0 + r, 270]
  ]
  return corners.flatMap(([cx, cz, from]) =>
    Array.from({ length: STEP + 1 }, (_, i) => {
      const a = ((from + (i / STEP) * 90) * Math.PI) / 180
      return { x: cx + r * Math.cos(a), y: atY, z: cz + r * Math.sin(a) }
    })
  )
}

function path(points: P3[], close = true): string {
  const d = points
    .map((p, i) => {
      const q = iso(p)
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(2)} ${q.y.toFixed(2)}`
    })
    .join(' ')
  return close ? `${d} Z` : d
}

function seg(a: P3, b: P3): string {
  return path([a, b], false)
}

/**
 * The corners a solid actually shows a vertical edge at: its left and right
 * silhouette, plus the corner nearest the viewer. Picked from the projection
 * rather than hard-coded, so they stay right if the shape moves.
 */
function verticalEdges(top: P3[]): P3[] {
  let left = 0
  let right = 0
  let near = 0
  top.forEach((p, i) => {
    const q = iso(p)
    if (q.x < iso(top[left]).x) left = i
    if (q.x > iso(top[right]).x) right = i
    if (q.y > iso(top[near]).y) near = i
  })
  return [top[left], top[right], top[near]]
}

/** Top and bottom outlines plus the vertical edges between them. */
function prism(top: P3[], yBottom: number, edges = 3): string[] {
  const bottom = top.map(p => ({ ...p, y: yBottom }))
  return [
    path(top),
    path(bottom),
    ...verticalEdges(top)
      .slice(0, edges)
      .map(p => seg(p, { ...p, y: yBottom }))
  ]
}

/* ------------------------------------------------------------------ geometry */

/** Key body: length along z, width along x, thickness in y. */
const T = 26
const BODY_X = 60
const BODY_Z_FAR = -168
const BODY_Z_USB = 148

/** USB-A plug, projecting past the body's near end. */
const PLUG_Z = 232
const PLUG_X = 32
const PLUG_Y0 = 5
const PLUG_Y1 = 21

/** Keyring hole, near the far end. */
const HOLE = { z: -118, r: 25, inner: 18 }
/** The gold touch contact, an inset panel on the top face. */
const PAD = { z0: 58, z1: 122, x: 38, r: 12 }

/** Vault wheel, mounted on the top face. */
const HUB_Z = -14
const R_FLANGE = 60
const R_DRUM = 50
const DRUM_H = 13
const R_BEZEL = 42
const R_TRACK = 33
const R_BOSS = 10
const SPOKES = Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2)
/** Bolt lugs stand proud of the flange, one between each pair of spokes. */
const LUGS = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2 + Math.PI / 8)
/** A second, smaller dial offset on the drum face, as on the reference drawing. */
const DIAL = { x: -19, z: -34, r: 11 }

const TOP = T
const DRUM_TOP = TOP + DRUM_H

const bodyTop = roundedRectY(TOP, -BODY_X, BODY_X, BODY_Z_FAR, BODY_Z_USB, 46)
const plugTop = roundedRectY(PLUG_Y1, -PLUG_X, PLUG_X, BODY_Z_USB - 10, PLUG_Z, 4)
const padTop = roundedRectY(TOP + 0.5, -PAD.x, PAD.x, PAD.z0, PAD.z1, PAD.r)
const drumTop = ringY(DRUM_TOP, R_DRUM, 0, HUB_Z)
const bossTop = ringY(DRUM_TOP + 9, R_BOSS - 3, 0, HUB_Z)

function lug(angle: number): P3[] {
  const spread = 0.14
  const [r0, r1] = [R_FLANGE - 8, R_FLANGE + 9]
  const corners: [number, number][] = [
    [r0, angle - spread],
    [r1, angle - spread],
    [r1, angle + spread],
    [r0, angle + spread]
  ]
  return corners.map(([r, a]) => ({
    x: r * Math.cos(a),
    y: TOP + 4,
    z: HUB_Z + r * Math.sin(a)
  }))
}

/* --------------------------------------------------------------- view bounds */

/** Extremes of the dashed scaffold, so the viewBox frames drawing plus rails. */
const SCAFFOLD: P3[] = [
  { x: -190, y: 0, z: -290 },
  { x: 190, y: 0, z: 290 },
  { x: 0, y: 120, z: HUB_Z },
  { x: 0, y: -70, z: HUB_Z }
]

const BOUNDS = [...bodyTop, ...plugTop, ...SCAFFOLD].map(iso).reduce(
  (acc, q) => ({
    minX: Math.min(acc.minX, q.x),
    maxX: Math.max(acc.maxX, q.x),
    minY: Math.min(acc.minY, q.y),
    maxY: Math.max(acc.maxY, q.y)
  }),
  { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
)
const ZOOM = 0.9
const MID_X = (BOUNDS.minX + BOUNDS.maxX) / 2
const MID_Y = (BOUNDS.minY + BOUNDS.maxY) / 2
const VIEW_W = (BOUNDS.maxX - BOUNDS.minX) * ZOOM
const VIEW_H = (BOUNDS.maxY - BOUNDS.minY) * ZOOM
const VIEW_BOX = [MID_X - VIEW_W / 2, MID_Y - VIEW_H / 2, VIEW_W, VIEW_H].map(n => n.toFixed(1)).join(' ')

/* --------------------------------------------------------------- components */

interface VaultBackdropProps {
  /** Stroke colour — pass the theme's primary text colour so it inverts with the theme. */
  color: string
  /** Hairline wash; the copy below it has to stay the loudest thing on screen. */
  opacity?: number
}

export function VaultBackdrop({ color, opacity = 0.3 }: VaultBackdropProps) {
  const solid = {
    stroke: color,
    strokeWidth: 1.1,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid meet">
        {/* ── Construction scaffold ── */}
        <G {...solid} strokeWidth={0.8} strokeDasharray="7 8" opacity={opacity * 0.5}>
          {/* Centrelines through the wheel: along the key, across it, and up */}
          <Path d={seg({ x: 0, y: TOP, z: -290 }, { x: 0, y: TOP, z: 290 })} />
          <Path d={seg({ x: -190, y: TOP, z: HUB_Z }, { x: 190, y: TOP, z: HUB_Z })} />
          <Path d={seg({ x: 0, y: -70, z: HUB_Z }, { x: 0, y: 120, z: HUB_Z })} />
          {/* and through the keyring hole */}
          <Path d={seg({ x: 0, y: -60, z: HOLE.z }, { x: 0, y: 96, z: HOLE.z })} />
          <Path d={seg({ x: -150, y: TOP, z: HOLE.z }, { x: 150, y: TOP, z: HOLE.z })} />
          {/* Rails offset off each long edge, the way a drawing carries its
              dimensions out past the part */}
          {[-112, 112].map(x => (
            <Path key={`rail${x}`} d={seg({ x, y: 0, z: -270 }, { x, y: 0, z: 270 })} />
          ))}
          {/* Cross-rails past each end */}
          {[BODY_Z_FAR - 64, PLUG_Z + 42].map(z => (
            <Path key={`cross${z}`} d={seg({ x: -170, y: 0, z }, { x: 170, y: 0, z })} />
          ))}
        </G>

        {/* ── Key body ── */}
        <G {...solid} opacity={opacity}>
          {prism(bodyTop, 0).map((d, i) => (
            <Path key={`body${i}`} d={d} />
          ))}

          {/* USB-A plug, and the tongue inside its mouth */}
          {prism(plugTop, PLUG_Y0).map((d, i) => (
            <Path key={`plug${i}`} d={d} />
          ))}
          <Path
            d={path([
              { x: -PLUG_X, y: PLUG_Y0, z: PLUG_Z },
              { x: -PLUG_X, y: PLUG_Y1, z: PLUG_Z },
              { x: PLUG_X, y: PLUG_Y1, z: PLUG_Z },
              { x: PLUG_X, y: PLUG_Y0, z: PLUG_Z }
            ])}
          />
          <Path
            d={path([
              { x: -PLUG_X + 7, y: PLUG_Y0 + 4, z: PLUG_Z - 1 },
              { x: -PLUG_X + 7, y: PLUG_Y1 - 4, z: PLUG_Z - 1 },
              { x: PLUG_X - 7, y: PLUG_Y1 - 4, z: PLUG_Z - 1 },
              { x: PLUG_X - 7, y: PLUG_Y0 + 4, z: PLUG_Z - 1 }
            ])}
          />

          {/* Touch contact panel */}
          <Path d={path(padTop)} />

          {/* Keyring hole: rim on the top face, wall down to the underside */}
          <Path d={path(ringY(TOP, HOLE.r, 0, HOLE.z))} />
          <Path d={path(ringY(TOP, HOLE.inner, 0, HOLE.z))} />
          <Path d={path(ringY(2, HOLE.inner, 0, HOLE.z))} />
        </G>

        {/* ── Vault wheel ── */}
        <G {...solid} opacity={opacity}>
          {/* Flange plate the drum stands on, with its bolt lugs */}
          <Path d={path(ringY(TOP, R_FLANGE, 0, HUB_Z))} />
          {LUGS.map((a, i) => (
            <G key={`lug${i}`}>
              {prism(lug(a), TOP, 2).map((d, j) => (
                <Path key={`l${i}-${j}`} d={d} />
              ))}
            </G>
          ))}

          {/* Drum: top and bottom rings joined at their silhouette */}
          <Path d={path(ringY(TOP, R_DRUM, 0, HUB_Z))} />
          <Path d={path(drumTop)} />
          {verticalEdges(drumTop)
            .slice(0, 2)
            .map((p, i) => (
              <Path key={`drum${i}`} d={seg(p, { ...p, y: TOP })} />
            ))}

          {/* Face rings */}
          <Path d={path(ringY(DRUM_TOP, R_BEZEL, 0, HUB_Z))} />
          <Path d={path(ringY(DRUM_TOP, R_TRACK, 0, HUB_Z))} />

          {/* Handle spokes with their grips */}
          {SPOKES.map((a, i) => {
            const inner: P3 = {
              x: R_BOSS * Math.cos(a),
              y: DRUM_TOP + 4,
              z: HUB_Z + R_BOSS * Math.sin(a)
            }
            const outer: P3 = {
              x: (R_TRACK - 3) * Math.cos(a),
              y: DRUM_TOP + 4,
              z: HUB_Z + (R_TRACK - 3) * Math.sin(a)
            }
            return (
              <G key={`spoke${i}`}>
                <Path d={seg(inner, outer)} />
                <Path d={path(ringY(DRUM_TOP + 4, 4.5, outer.x, outer.z))} />
              </G>
            )
          })}

          {/* Boss at the centre of the wheel */}
          <Path d={path(ringY(DRUM_TOP + 4, R_BOSS, 0, HUB_Z))} />
          <Path d={path(bossTop)} />
          {verticalEdges(bossTop)
            .slice(0, 2)
            .map((p, i) => (
              <Path key={`boss${i}`} d={seg(p, { ...p, y: DRUM_TOP + 4 })} />
            ))}

          {/* Secondary dial, offset on the drum face */}
          <Path d={path(ringY(DRUM_TOP, DIAL.r, DIAL.x, HUB_Z + DIAL.z))} />
          <Path d={path(ringY(DRUM_TOP + 4, DIAL.r - 4, DIAL.x, HUB_Z + DIAL.z))} />
        </G>
      </Svg>
    </View>
  )
}

export default VaultBackdrop
