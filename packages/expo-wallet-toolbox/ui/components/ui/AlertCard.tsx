/**
 * Glass Alert Card (spec Part 2) — themed replacement for Alert.alert.
 * Imperative promise API so plain utils can call it:
 *
 *   const choice = await showAlert({
 *     title, message,
 *     buttons: [
 *       { text: t('cancel'), style: 'cancel', key: 'cancel' },
 *       { text: t('delete'), style: 'destructive', key: 'delete' },
 *     ],
 *   })
 *   if (choice === 'delete') { ... }
 *
 * <AlertHost /> must be mounted once, inside ThemeProvider (app/_layout.tsx).
 * Background is near-solid sheetBackground — deliberately NOT BlurView/LiquidGlass
 * (fractional-opacity-over-effect-view guardrail in context/theme/motion.ts).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'
import { useTheme, spacing, radii, typography, springs, durations, haptics } from '@bsv/expo-wallet-toolbox'

export interface AlertButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  /** Resolution value. Defaults to lowercased text. */
  key?: string
}

export interface AlertOptions {
  title: string
  message?: string
  /** Defaults to a single OK button (key "ok"). Max 3; 2 render side-by-side, 3 stack. */
  buttons?: AlertButton[]
}

type ActiveAlert = AlertOptions & { resolve: (key: string) => void }

let enqueue: ((a: ActiveAlert) => void) | null = null

export function showAlert(options: AlertOptions): Promise<string> {
  return new Promise<string>(resolve => {
    if (!enqueue) {
      console.warn('[AlertCard] AlertHost not mounted; resolving "cancel"')
      resolve('cancel')
      return
    }
    enqueue({ ...options, resolve })
  })
}

const DEFAULT_BUTTONS: AlertButton[] = [{ text: 'OK', key: 'ok' }]

/** Upper bound on waiting for the native modal's dismissal (iOS `onDismiss`),
 * so an alert whose modal never presented cannot hold the queue forever. */
const DISMISS_FALLBACK_MS = 1_000

export function AlertHost() {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()
  const [queue, setQueue] = useState<ActiveAlert[]>([])
  const current = queue[0] ?? null

  const progress = useSharedValue(0)
  const exiting = useRef(false)
  const lastHapticAlert = useRef<ActiveAlert | null>(null)
  // The pressed key, held until the modal is gone. The caller's promise must
  // not settle while the alert's native modal is still presented: a caller
  // that presents native UI next (the export's share sheet) would present it
  // ON this modal, and dismissing the modal takes it down before it can
  // report back.
  const pending = useRef<{ alert: ActiveAlert; key: string; fallback: ReturnType<typeof setTimeout> } | null>(null)
  const [hiding, setHiding] = useState(false)

  useEffect(() => {
    enqueue = (a: ActiveAlert) => setQueue(q => [...q, a])
    return () => {
      enqueue = null
      // Resolve all queued alerts with 'cancel' on unmount.
      setQueue(q => {
        q.forEach(a => a.resolve('cancel'))
        return []
      })
    }
  }, [])

  useEffect(() => {
    if (current) {
      // Reset progress to 0 before animating in to avoid stale values.
      progress.value = 0
      // Fire warning haptic at most once per distinct alert object.
      if (
        current.buttons?.some(b => b.style === 'destructive') &&
        lastHapticAlert.current !== current
      ) {
        lastHapticAlert.current = current
        haptics.warning()
      }
      progress.value = reducedMotion
        ? withTiming(1, { duration: durations.instant })
        : withSpring(1, springs.snappy)
    }
  }, [current, progress, reducedMotion])

  /** Resolve the dismissed alert and show the next one. Runs once per alert. */
  const finish = useCallback(() => {
    const done = pending.current
    if (!done) return
    pending.current = null
    clearTimeout(done.fallback)
    exiting.current = false
    setHiding(false)
    setQueue(q => (q[0] === done.alert ? q.slice(1) : q))
    done.alert.resolve(done.key)
  }, [])

  const dismiss = useCallback((key: string) => {
    if (!current || exiting.current) return
    exiting.current = true
    pending.current = { alert: current, key, fallback: setTimeout(finish, durations.instant + DISMISS_FALLBACK_MS) }
    progress.value = withTiming(0, { duration: durations.instant })
    // After the exit fade, hide the modal. iOS reports the native dismissal
    // through onDismiss; Android has no such event and nothing presented over
    // it to protect, so it finishes here.
    setTimeout(() => {
      if (Platform.OS === 'ios') setHiding(true)
      else finish()
    }, durations.instant)
  }, [current, progress, finish])

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current.fallback)
  }, [])

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + 0.05 * progress.value }],
  }))

  if (!current) return null
  const buttons = current.buttons?.length ? current.buttons : DEFAULT_BUTTONS
  const sideBySide = buttons.length === 2

  const buttonColor = (b: AlertButton) =>
    b.style === 'destructive' ? colors.error
    : b.style === 'cancel' ? colors.textSecondary
    : colors.info

  return (
    <Modal
      transparent
      visible={!hiding}
      animationType="none"
      onDismiss={finish}
      onRequestClose={() => dismiss('cancel')}
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
    >
      <Animated.View style={[styles.backdrop, { backgroundColor: colors.scrim }, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss('cancel')} />
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: colors.sheetBackground, borderColor: colors.separator },
            cardStyle,
          ]}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>{current.title}</Text>
          {!!current.message && (
            <Text style={[styles.message, { color: colors.textSecondary }]}>{current.message}</Text>
          )}
          <View style={[styles.buttonGroup, { borderTopColor: colors.separator }, !sideBySide && styles.buttonGroupStacked]}>
            {buttons.map((b, i) => (
              <Pressable
                key={b.key ?? b.text}
                onPress={() => dismiss(b.key ?? b.text.toLowerCase())}
                style={({ pressed }) => [
                  styles.button,
                  // flex:1 only splits the two-up row; in the stacked column it
                  // resolves to a zero flex-basis and clips the label against
                  // minHeight, so stacked buttons size to their content instead.
                  sideBySide && styles.buttonRowItem,
                  sideBySide && i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
                  !sideBySide && i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
                  pressed && { backgroundColor: colors.fillTertiary },
                ]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: buttonColor(b) },
                    (b.style === 'destructive' || b.style === 'cancel') && styles.buttonTextBold,
                  ]}
                >
                  {b.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: 280,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingTop: spacing.xl,
  },
  title: {
    ...typography.headline,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  message: {
    ...typography.footnote,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xs,
  },
  buttonGroup: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttonGroupStacked: { flexDirection: 'column' },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    // Keep long labels off the card edge / hairline divider so they wrap
    // inside the button instead of touching (or escaping) the border.
    paddingHorizontal: spacing.sm,
  },
  buttonRowItem: { flex: 1 },
  buttonText: { ...typography.body, textAlign: 'center' },
  buttonTextBold: { fontWeight: '600' },
})
