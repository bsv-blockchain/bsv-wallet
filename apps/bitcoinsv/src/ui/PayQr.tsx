// A real, scannable QR code in the prototype's look (components/fake-qr.tsx):
// a white card, a mark in the middle, flipping up into place as it appears (.qr-flip-in). The modules
// come from the `qrcode` encoder at error correction H, so the centre mark
// never stops it scanning. Unlike the prototype's decorative code, the modules
// are solid and touching and the finder squares square: rounded dots or
// rounded finders stop stricter scanners (OpenCV's reference decoder) reading
// it, and a pay code must scan in any wallet. Checked by decoding screenshots.
import React, { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import Svg, { G, Rect } from 'react-native-svg'
import QRCode from 'qrcode'
import { usePalette } from '../theme'
import { useReducedMotion } from './motion'

const INK = '#171717'

/** @keyframes qr-flip-in */
const qrFlipIn = css.keyframes({
  from: { opacity: 0, transform: [{ perspective: 900 }, { rotateX: '58deg' }] },
  to: { opacity: 1, transform: [{ perspective: 900 }, { rotateX: '0deg' }] }
})

/** The module grid for `value`, or null if it can't be encoded. */
function modulesFor(value: string): { n: number; on: (x: number, y: number) => boolean } | null {
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'H' })
    const n = qr.modules.size
    const data = qr.modules.data
    return { n, on: (x, y) => !!data[y * n + x] }
  } catch {
    return null
  }
}

export function PayQr({ value, size = 196, center }: { value: string; size?: number; center?: React.ReactNode }) {
  const palette = usePalette()
  const still = useReducedMotion()
  const grid = useMemo(() => modulesFor(value), [value])

  const body = useMemo(() => {
    if (!grid) return null
    const { n, on } = grid
    const inFinder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
    // keep the middle clear for the mark: the encoder's H level carries it
    const c = n / 2
    const clear = Math.ceil(n * 0.11)
    const inCenter = (x: number, y: number) =>
      x >= c - clear - 0.5 && x < c + clear - 0.5 && y >= c - clear - 0.5 && y < c + clear - 0.5
    // each row's runs of dark modules as one rectangle, overlapping the next
    // row a little: separate squares leave anti-aliased seams that read as gaps
    const dark = (x: number, y: number) => on(x, y) && !inFinder(x, y) && !(center && inCenter(x, y))
    const cells: React.ReactNode[] = []
    for (let y = 0; y < n; y++) {
      let x = 0
      while (x < n) {
        if (!dark(x, y)) {
          x++
          continue
        }
        const from = x
        while (x < n && dark(x, y)) x++
        cells.push(<Rect key={`${from}-${y}`} x={from} y={y} width={x - from + 0.06} height={1.06} />)
      }
    }
    const finder = (fx: number, fy: number) => (
      <G key={`f${fx}-${fy}`}>
        <Rect x={fx + 0.5} y={fy + 0.5} width={6} height={6} fill="none" stroke={INK} strokeWidth={1} />
        <Rect x={fx + 2} y={fy + 2} width={3} height={3} />
      </G>
    )
    return { n, cells, finders: [finder(0, 0), finder(n - 7, 0), finder(0, n - 7)] }
  }, [grid, center])

  return (
    <Animated.View
      style={[
        styles.card,
        // shadow-sm ring-1 ring-border
        { boxShadow: `0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}`, transformOrigin: ['50%', '80%', 0] },
        still
          ? null
          : {
              animationName: qrFlipIn,
              animationDuration: 700,
              animationTimingFunction: cubicBezier(0.22, 1, 0.36, 1),
              animationFillMode: 'both'
            }
      ]}
    >
      <View style={{ width: size, height: size }}>
        {body && (
          <Svg width={size} height={size} viewBox={`-0.5 -0.5 ${body.n + 1} ${body.n + 1}`}>
            <G fill={INK}>
              {body.finders}
              {body.cells}
            </G>
          </Svg>
        )}
      </View>
      {center && (
        <View pointerEvents="none" style={styles.centerWrap}>
          <View style={styles.center}>{center}</View>
        </View>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  // rounded-3xl bg-white p-5
  card: { borderRadius: 24, backgroundColor: '#ffffff', padding: 20 },
  centerWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  center: { borderRadius: 999, backgroundColor: '#ffffff', padding: 4 }
})
