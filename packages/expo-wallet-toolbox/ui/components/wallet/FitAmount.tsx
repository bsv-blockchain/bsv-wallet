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
import { splitAmountFraction } from '../../../core/amountFormatHelpers'

/**
 * Never let a figure be smaller than this, so a pathological value stays
 * legible rather than collapsing (iOS Fabric's own fit-to-width bottoms out at
 * 4pt and ignores `minimumFontScale`, which is why this measures instead).
 */
const MIN_FONT_SIZE = 12

/** Headroom for rounding and the trailing space a wrapped line drops. */
const FIT_MARGIN = 0.98

/** Ignore width changes smaller than this, so rounding never re-triggers a fit. */
const WIDTH_EPSILON = 1

export interface FitAmountProps {
  value: string
  unit?: string
  /** Style of the figure. Its fontSize, lineHeight and letterSpacing are scaled together. */
  style: StyleProp<TextStyle>
  unitStyle?: StyleProp<TextStyle>
  /**
   * When set, the minor units are drawn in this style and hung from the top,
   * the way a price tag writes cents. Its fontSize, lineHeight and
   * letterSpacing scale with the figure; marginTop stays, matching `style`'s.
   */
  fractionStyle?: StyleProp<TextStyle>
}

/**
 * A figure that always sits on one line: however long `value` is, the type
 * shrinks until it fits the width it is given, and grows back to full size
 * when a shorter value arrives.
 *
 * Two facts drive it: the width of the slot (the wrapper's layout) and the
 * width the figure takes on one line at full size (from `onTextLayout`). Width
 * scales linearly with font size, so the scale is simply their ratio. Each is
 * stored as it arrives and the scale is derived from both, so it does not
 * matter which the platform reports first. Nothing is ellipsized or wrapped, so
 * no digit is ever hidden.
 */
export function FitAmount({ value, unit, style, unitStyle, fractionStyle }: FitAmountProps) {
  const [available, setAvailable] = useState(0)
  const [fullWidth, setFullWidth] = useState(0)

  const base = StyleSheet.flatten(style) ?? {}
  const baseSize = base.fontSize ?? 17
  const unitBase = StyleSheet.flatten(unitStyle) ?? {}
  const floor = Math.min(1, MIN_FONT_SIZE / baseSize)

  const scale = available > 0 && fullWidth > 0 ? Math.min(1, Math.max(floor, (available / fullWidth) * FIT_MARGIN)) : 1

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width
    setAvailable(prev => (Math.abs(prev - width) > WIDTH_EPSILON ? width : prev))
  }, [])

  // `scale` is the size this layout was produced at, which turns the width it
  // reports back into the full-size width.
  const onTextLayout = useCallback(
    (e: NativeSyntheticEvent<TextLayoutEventData>) => {
      // A figure that overflowed wraps, so the widths of all its lines add up to
      // the width it would take on one.
      const natural = e.nativeEvent.lines.reduce((sum, line) => sum + line.width, 0)
      if (natural <= 0) return
      const full = natural / scale
      setFullWidth(prev => (Math.abs(prev - full) > WIDTH_EPSILON ? full : prev))
    },
    [scale]
  )

  const scaled: TextStyle = {
    fontSize: baseSize * scale,
    ...(base.lineHeight != null ? { lineHeight: base.lineHeight * scale } : null),
    ...(base.letterSpacing != null ? { letterSpacing: base.letterSpacing * scale } : null)
  }

  const unitScaled = unitBase.fontSize != null ? { fontSize: unitBase.fontSize * scale } : null
  const unitRun = unit ? <Text style={[unitStyle, unitScaled]}> {unit}</Text> : null

  const parts = fractionStyle ? splitAmountFraction(value) : null
  if (!parts?.frac) {
    return (
      <View onLayout={onLayout} style={styles.fill}>
        <Text style={[style, scaled]} onTextLayout={onTextLayout}>
          {value}
          {unitRun}
        </Text>
      </View>
    )
  }

  const frac = StyleSheet.flatten(fractionStyle) ?? {}
  const fracScaled: TextStyle = {
    ...(frac.fontSize != null ? { fontSize: frac.fontSize * scale } : null),
    ...(frac.lineHeight != null ? { lineHeight: frac.lineHeight * scale } : null),
    ...(frac.letterSpacing != null ? { letterSpacing: frac.letterSpacing * scale } : null)
  }

  // Raised cents need separate <Text>s in a row (nested text baseline-aligns
  // and cannot be lifted), but only one <Text> can report a width. So a hidden
  // copy holds the same runs nested, at the same sizes, and does the measuring;
  // its width is the row's width.
  return (
    <View onLayout={onLayout} style={styles.fill}>
      <Text
        style={[style, scaled, styles.measure]}
        onTextLayout={onTextLayout}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {parts.head}
        <Text style={[fractionStyle, fracScaled, styles.noMargin]}>{parts.frac}</Text>
        {parts.tail}
        {unitRun}
      </Text>
      <View style={styles.row}>
        <Text style={[style, scaled]}>{parts.head}</Text>
        <Text style={[fractionStyle, fracScaled]}>{parts.frac}</Text>
        {parts.tail || unit ? (
          <Text style={[style, scaled]}>
            {parts.tail}
            {unitRun}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { alignSelf: 'stretch', alignItems: 'center' },
  // `flex-start` hangs the minor units from the top of the figure's line box.
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  measure: { position: 'absolute', opacity: 0 },
  noMargin: { marginTop: 0 }
})
