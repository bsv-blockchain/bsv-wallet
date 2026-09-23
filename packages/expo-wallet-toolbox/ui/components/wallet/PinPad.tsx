/**
 * The PIN keypad.
 *
 * Its own numeric pad rather than a TextInput with `keyboardType="numeric"`:
 * the system keyboard on this input would put the digits of a wallet PIN
 * through the keyboard's own autocorrect and clipboard machinery, and on
 * Android that can be a third-party IME the user installed. A pad that only
 * ever emits 0-9 keeps the secret inside this process.
 *
 * The dots are the only progress indicator — no digit is ever echoed, and
 * there is no "show PIN" affordance, because the whole point of a six-digit
 * secret is that it is entered in front of other people.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Animated, Platform, StyleSheet, Text, View } from 'react-native'
import { useTheme, spacing, radii, typography, haptics } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../ui/PressableScale'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const

export interface PinPadProps {
  /** Digits entered so far. Owned by the parent so it can clear on failure. */
  value: string
  onChange: (next: string) => void
  /** Filled dots to draw. The PIN length the user is working towards. */
  length: number
  /** Fires once `value` reaches `length`. */
  onComplete: (pin: string) => void
  /** Headline above the dots. */
  title: string
  subtitle?: string
  /** Shown in place of the subtitle, in the error colour, and shakes the dots. */
  error?: string | null
  /** Blocks input — mid-derivation, or throttled after wrong guesses. */
  disabled?: boolean
  /** Optional extra control under the pad (e.g. "Use Face ID", "Cancel"). */
  footer?: React.ReactNode
}

export default function PinPad({
  value,
  onChange,
  length,
  onComplete,
  title,
  subtitle,
  error,
  disabled = false,
  footer
}: PinPadProps) {
  const { colors } = useTheme()
  const shake = useMemo(() => new Animated.Value(0), [])
  const completedFor = useRef<string | null>(null)

  /* A wrong PIN has to be felt as well as read: the shake is what tells someone
     who is looking at the keypad, not the message, that nothing was accepted. */
  useEffect(() => {
    if (!error) return
    haptics.error()
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 60, useNativeDriver: true })
    ]).start()
  }, [error, shake])

  /* Completion fires from an effect, not from the tap handler, so the last dot
     is painted before the (blocking, ~300ms) key derivation starts. Guarded by
     the value it fired for, so a re-render cannot submit the same PIN twice. */
  useEffect(() => {
    if (value.length !== length) {
      if (value.length < length) completedFor.current = null
      return
    }
    if (completedFor.current === value) return
    completedFor.current = value
    onComplete(value)
  }, [value, length, onComplete])

  const press = useCallback(
    (key: string) => {
      if (disabled) return
      haptics.tap()
      if (key === 'del') {
        onChange(value.slice(0, -1))
        return
      }
      if (value.length >= length) return
      onChange(value + key)
    },
    [disabled, onChange, value, length]
  )

  const translateX = shake.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] })

  return (
    <View style={styles.root}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
      <Text
        style={[styles.subtitle, { color: error ? colors.error : colors.textSecondary }]}
        numberOfLines={2}
      >
        {error || subtitle || ' '}
      </Text>

      <Animated.View style={[styles.dots, { transform: [{ translateX }] }]}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length
          return (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  backgroundColor: filled ? (error ? colors.error : colors.textPrimary) : 'transparent',
                  borderColor: error ? colors.error : colors.textQuaternary
                }
              ]}
            />
          )
        })}
      </Animated.View>

      <View style={[styles.grid, disabled && styles.gridDisabled]}>
        {KEYS.map((k, i) =>
          k === '' ? (
            <View key={i} style={styles.key} />
          ) : (
            <PressableScale
              key={i}
              scaleTo={0.92}
              onPress={() => press(k)}
              style={[
                styles.key,
                k !== 'del' && { backgroundColor: colors.fillTertiary }
              ]}
              accessibilityLabel={k === 'del' ? 'Delete' : k}
            >
              <Text style={[styles.keyLabel, { color: colors.textPrimary }]}>
                {k === 'del' ? '⌫' : k}
              </Text>
            </PressableScale>
          )
        )}
      </View>

      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  )
}

const KEY_SIZE = 72

const styles = StyleSheet.create({
  root: { alignItems: 'center', width: '100%' },
  title: { ...typography.title2, textAlign: 'center' },
  subtitle: { ...typography.subhead, textAlign: 'center', marginTop: spacing.sm, minHeight: 40 },
  dots: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.xxl },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: KEY_SIZE * 3 + spacing.lg * 2,
    gap: spacing.lg
  },
  gridDisabled: { opacity: 0.4 },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // Tabular figures so the digits do not jitter between keys.
  keyLabel: {
    fontSize: 28,
    fontWeight: '400',
    fontVariant: ['tabular-nums'],
    ...Platform.select({ android: { includeFontPadding: false } })
  },
  footer: { marginTop: spacing.xxl, alignItems: 'center' }
})
