import React, { useCallback, useState } from 'react'
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextStyle
} from 'react-native'

/**
 * Never let a figure be smaller than this, so a pathological value stays
 * legible rather than collapsing (iOS Fabric's own fit-to-width bottoms out at
 * 4pt and ignores `minimumFontScale`, which is why this measures instead).
 */
const MIN_FONT_SIZE = 12

/** Headroom for rounding and the trailing space a wrapped line drops. */
const FIT_MARGIN = 0.98

export interface FitAmountProps {
  value: string
  unit?: string
  /** Style of the figure. Its fontSize, lineHeight and letterSpacing are scaled together. */
  style: StyleProp<TextStyle>
  unitStyle?: StyleProp<TextStyle>
}

/**
 * A figure that always sits on one line: however long `value` is, the type
 * shrinks until it fits the width it is given, and grows back to full size
 * when a shorter value arrives.
 *
 * The line widths the platform reports for the current size scale linearly with
 * font size, so one correction lands within a pixel or two. A second pass
 * confirms it and stops. Nothing is ellipsized or wrapped, so no digit is ever
 * hidden.
 */
export function FitAmount({ value, unit, style, unitStyle }: FitAmountProps) {
  const [available, setAvailable] = useState(0)
  const [scale, setScale] = useState(1)

  const base = StyleSheet.flatten(style) ?? {}
  const baseSize = base.fontSize ?? 17
  const unitBase = StyleSheet.flatten(unitStyle) ?? {}
  const floor = Math.min(1, MIN_FONT_SIZE / baseSize)

  const onLayout = useCallback((e: LayoutChangeEvent) => setAvailable(e.nativeEvent.layout.width), [])

  const onTextLayout = useCallback(
    (e: NativeSyntheticEvent<TextLayoutEventData>) => {
      if (available <= 0) return
      // A figure that overflowed wraps, so the widths of all its lines add up
      // to the width it would take on one.
      const natural = e.nativeEvent.lines.reduce((sum, line) => sum + line.width, 0)
      if (natural <= 0) return
      const next = Math.min(1, Math.max(floor, scale * (available / natural) * FIT_MARGIN))
      if (Math.abs(next - scale) > 0.005) setScale(next)
    },
    [available, scale, floor]
  )

  const scaled: TextStyle = {
    fontSize: baseSize * scale,
    ...(base.lineHeight != null ? { lineHeight: base.lineHeight * scale } : null),
    ...(base.letterSpacing != null ? { letterSpacing: base.letterSpacing * scale } : null)
  }

  return (
    <View onLayout={onLayout} style={styles.fill}>
      <Text style={[style, scaled]} onTextLayout={onTextLayout}>
        {value}
        {unit ? (
          <Text style={[unitStyle, unitBase.fontSize != null ? { fontSize: unitBase.fontSize * scale } : null]}>
            {' '}
            {unit}
          </Text>
        ) : null}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { alignSelf: 'stretch', alignItems: 'center' }
})
