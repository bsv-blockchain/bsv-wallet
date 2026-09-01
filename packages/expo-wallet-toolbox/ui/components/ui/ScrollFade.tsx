/**
 * A short fade at the top of a scrolling list, so rows dissolve into the
 * backdrop as they pass under whatever is pinned above them.
 *
 * Without it the list has a hard edge: a row is fully drawn, then abruptly
 * clipped mid-glyph. The fade is drawn in the backdrop's own colour rather
 * than as a translucent black or white, because the screen behind it is a
 * gradient — anything else banded against it.
 *
 * `color` must therefore be the backdrop colour AT this strip's position, not
 * the screen's base colour: use `sampleScreenGradient` to work it out.
 */
import React, { useId } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

/**
 * The colour ScreenGradient paints at `y`.
 *
 * ScreenGradient resolves `from` into `to` over `height` and is a flat `to`
 * below that, so this is the same linear interpolation, clamped.
 */
export function sampleScreenGradient(from: string, to: string, y: number, height = 320): string {
  const parse = (hex: string): [number, number, number] | undefined => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return undefined
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const a = parse(from)
  const b = parse(to)
  // A non-hex theme colour (rgba(), a named colour) is not worth guessing at:
  // the flat base is the honest answer everywhere below the gradient anyway.
  if (!a || !b || height <= 0) return to
  const ratio = Math.max(0, Math.min(1, y / height))
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * ratio)
  return `#${[0, 1, 2].map(i => mix(i).toString(16).padStart(2, '0')).join('')}`
}

interface Props {
  /** The backdrop colour where this strip sits. */
  color: string
  height?: number
}

export default function ScrollFade({ color, height = 24 }: Props) {
  const id = `scroll-fade-${useId()}`
  return (
    <View
      pointerEvents="none"
      style={[styles.fade, { height }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1
  }
})
