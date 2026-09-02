/**
 * Presence — the quiet line that says whether another person's device is
 * actually there.
 *
 * This is the only screen in the app with a live peer, and this row is the only
 * place that fact is visible. It is STATUS, not decoration: every state below
 * is entered from a real signal, and there is deliberately no state for "we
 * think they're probably nearby".
 *
 * ── Why there is no separate "device found" ──
 *
 * The AWDL transport surfaces exactly two things to JS: a decoded frame, or an
 * error (see packages/react-native-localpay-transport — `startListening`,
 * `sendFrame`). There is no connection callback, so neither side can observe
 * discovery separately from the TLS-PSK handshake. By the time anything reaches
 * JS, the peer has been found AND the encrypted channel has carried real bytes.
 * Those two facts arrive together, so they are one state — `linked` — rather
 * than an invented pair of steps with a timer between them. Splitting them
 * would be theatre, and on a payment screen theatre is a lie about whether the
 * other device is really there.
 *
 * ── The honest degrades ──
 *
 * `qr` exists because the QR hand-off has no live link at all. It must never
 * animate like a connection or borrow connection language: the payer's device
 * is not talking to the payee's, and pretending otherwise would tell someone a
 * stranger's phone is on the other end of a channel that does not exist.
 *
 * `ready` says a nearby route is *available* — the peer's pairing code claims
 * AWDL and this device supports it — not that anything is open yet.
 *
 * ── Colour ──
 *
 * Green appears on exactly one state, `paid`, because green on this screen
 * means confirmed money and nothing else. `linked` — the moment the other
 * person's device is proven present — earns its emphasis from weight and text
 * colour instead, never from the accent.
 */
import React, { useEffect } from 'react'
import { StyleSheet, Text } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useTheme, spacing, typography, durations, easings, springs } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

export type PresenceState =
  /** No live link on this path. The QR hand-off. */
  | 'qr'
  /** An encrypted nearby route is available; nothing is open yet. */
  | 'ready'
  /** Genuinely listening or searching for the peer right now. */
  | 'waiting'
  /** An encrypted peer-to-peer link carried real bytes. Found + secured, proven together. */
  | 'linked'
  /** Confirmed money. The only state that may be green. */
  | 'paid'

interface PresenceRowProps {
  state: PresenceState
  /** Localized, role-appropriate sentence. The screen owns the wording. */
  label: string
  /** The peer's resolved display name, when identity lookup found one. */
  peer?: string | null
  /**
   * Which radio the `ready`/`waiting` states are about. BLE is the only rung
   * that crosses iOS↔Android, so a Bluetooth link must not wear a Wi-Fi glyph:
   * the glyph is what tells the person paying which radio to look at when the
   * link does not come up. Every other state ignores this — `qr` has no radio,
   * and `linked`/`paid` are claims about the payment, not the pipe.
   */
  medium?: 'wifi' | 'bluetooth'
}

type IconName = keyof IoniconsComponent['glyphMap']

function iconFor(state: PresenceState, medium: 'wifi' | 'bluetooth'): IconName {
  switch (state) {
    case 'qr':
      return 'qr-code-outline'
    case 'ready':
    case 'waiting':
      return medium === 'bluetooth' ? 'bluetooth' : 'wifi'
    case 'linked':
      return 'lock-closed'
    case 'paid':
      return 'checkmark-circle'
  }
}

export default function PresenceRow({ state, label, peer, medium = 'wifi' }: PresenceRowProps) {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const reducedMotion = useReducedMotion()

  // 0 → 1 on every state change. Re-run rather than cross-faded: the row is one
  // short line, so a clean re-entry reads as "this changed" where a dissolve
  // reads as a rendering artifact.
  const enter = useSharedValue(1)
  // Ambient breathing while genuinely waiting. Never runs in any other state —
  // a pulsing glyph beside "Paid" would imply something is still in flight.
  const pulse = useSharedValue(1)

  useEffect(() => {
    if (reducedMotion) {
      enter.value = 0
      enter.value = withTiming(1, { duration: durations.instant, easing: easings.out })
      return
    }
    enter.value = 0
    enter.value = withSpring(1, springs.snappy)
  }, [state, reducedMotion, enter])

  useEffect(() => {
    if (state !== 'waiting' || reducedMotion) {
      pulse.value = withTiming(1, { duration: durations.instant, easing: easings.out })
      return
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: durations.moderate, easing: easings.out }),
        withTiming(1, { duration: durations.moderate, easing: easings.out })
      ),
      -1,
      false
    )
  }, [state, reducedMotion, pulse])

  // Opacity is animated on this row's own content only. It is never an ancestor
  // of LiquidGlass or BlurView — see the guardrail at the top of
  // context/theme/motion.ts — and must not become one.
  const rowStyle = useAnimatedStyle(() => {
    if (reducedMotion) return { opacity: enter.value }
    return {
      opacity: enter.value,
      transform: [{ translateY: (1 - enter.value) * 6 }],
    }
  }, [reducedMotion])

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }), [])

  const paid = state === 'paid'
  const strong = paid || state === 'linked'
  const dotColor = paid ? colors.success : strong ? colors.textPrimary : colors.textTertiary
  const labelColor = paid ? colors.success : strong ? colors.textPrimary : colors.textSecondary

  return (
    <Animated.View
      // Announced as one string so VoiceOver does not read the peer name as a
      // separate, contextless element.
      accessibilityRole="text"
      accessibilityLabel={peer ? `${label}. ${peer}` : label}
      style={[styles.row, rowStyle]}
    >
      {/* One glyph for every state, breathing only while `waiting` — the pulse
          effect above pins the opacity at 1 in every other state. `waiting`
          used to draw a bare dot, which meant the `medium` prop could not
          reach the one state where naming the radio matters most: the payee
          waiting on a link that may be Bluetooth. */}
      <Animated.View style={dotStyle}>
        <Ionicons name={iconFor(state, medium)} size={13} color={dotColor} />
      </Animated.View>
      <Text style={[styles.label, { color: labelColor }, strong && styles.labelStrong]} numberOfLines={1}>
        {label}
      </Text>
      {!!peer && (
        <>
          <Text style={[styles.sep, { color: colors.textQuaternary }]}>·</Text>
          <Text style={[styles.peer, { color: colors.textSecondary }]} numberOfLines={1}>
            {peer}
          </Text>
        </>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    // Held constant across every state so the content beneath never shifts as
    // the status changes.
    minHeight: 20,
    paddingHorizontal: spacing.sm,
  },
  label: { ...typography.footnote, flexShrink: 1 },
  labelStrong: { fontWeight: '600' },
  sep: { ...typography.footnote },
  peer: { ...typography.footnote, flexShrink: 1 },
})
