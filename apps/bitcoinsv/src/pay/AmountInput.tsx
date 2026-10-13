// The prototype's AmountInput (components/amount-input.tsx): big amount entry
// with the Wallet-total treatment, the decimals set at half size and
// top-aligned while you type. A text field can't style part of its own text,
// so the figure is drawn as Text and the real TextInput sits over it,
// transparent, taking the typing (and the keypad). The caret is drawn too,
// always at the end, blinking as the prototype's (caret 1s steps(1)).
import React, { useState } from 'react'
import { StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native'
import Animated, { css, steps } from 'react-native-reanimated'
import { font, usePalette } from '../theme'
import { useReducedMotion } from '../ui/motion'

/** @keyframes caret */
const caret = css.keyframes({
  '0%': { opacity: 1 },
  '50%': { opacity: 0 },
  '100%': { opacity: 1 }
})

// Line boxes taller than the prototype's leading-none: iOS clips the tops of
// big figures to a tight line height. The decimals and caret are moved down
// by the extra half-leading so they still sit where the prototype puts them.
const LEAD = 1.2

export function AmountInput({
  value,
  onChange,
  accessibilityLabel,
  size = 72,
  invalid = false,
  autoFocus = false
}: {
  value: string
  onChange: (raw: string) => void
  accessibilityLabel: string
  /** the whole number's font size (text-7xl: 72) */
  size?: number
  invalid?: boolean
  autoFocus?: boolean
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [focused, setFocused] = useState(false)
  const empty = value === ''
  const [whole, decimals] = value.split('.')
  const hasDot = value.includes('.')
  // text-muted-foreground/50 while empty, text-destructive when it's too much
  const color = invalid ? palette.destructive : empty ? palette.mutedForeground + '80' : palette.foreground
  const half = ((LEAD - 1) * size) / 2
  const figure: TextStyle = { color, fontVariant: ['tabular-nums', 'lining-nums'] }
  const small = size * 0.5

  return (
    <View style={styles.row}>
      <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={[font(800), figure, { fontSize: size, lineHeight: size * LEAD, letterSpacing: -size * 0.025 }]}>{empty ? '0' : whole || '0'}</Text>
        {hasDot && (
          <Text style={[font(800), figure, { fontSize: small, lineHeight: small * LEAD, marginTop: size * 0.14 + half - ((LEAD - 1) * small) / 2 }]}>
            .{decimals}
          </Text>
        )}
        {focused && (
          <Animated.View
            style={[
              { marginLeft: size * 0.06, marginTop: size * 0.12 + half, width: size * 0.05, height: size * 0.8, borderRadius: size, backgroundColor: color },
              still ? null : { animationName: caret, animationDuration: 1000, animationTimingFunction: steps(1), animationIterationCount: 'infinite' }
            ]}
          />
        )}
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="decimal-pad"
        autoFocus={autoFocus}
        autoComplete="off"
        caretHidden
        contextMenuHidden
        selectionColor="transparent"
        accessibilityLabel={accessibilityLabel}
        style={[StyleSheet.absoluteFill, styles.input]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  // unseen but still touchable and focusable: Android draws a TextInput's
  // text even when its colour is transparent
  input: { color: 'transparent', opacity: 0, padding: 0, fontSize: 16 }
})
