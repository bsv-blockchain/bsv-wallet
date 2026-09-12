/**
 * The vault ceremony sheet — the one place the user is told what to do with the
 * YubiKey and why. Globally mounted (beside PermissionSheet); driven by
 * VaultContext, which mirrors the ceremony singleton.
 *
 * Every phase says three things: WHY (the reason string / transfer summary),
 * WHAT to do now (the phase copy + illustration), and how far along it is
 * (countdown on awaiting-touch; `Signed k of n` and the batch number while a
 * multi-input withdrawal is being signed — spec §4.2 step 8). Motion is
 * scale/opacity of the sheet's own subviews only — never a fractional-opacity
 * animation over glass (the UIVisualEffectView freeze guardrail).
 *
 * Error copy comes from vaultErrorCopy. CeremonyState carries no serial, so a
 * serial-mismatch here can only list the vault's keys (read from meta); the
 * "That's X — you chose Y" wording is the transfer screen's, which knows both.
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ActivityIndicator, Platform } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  useReducedMotion,
  Easing
} from 'react-native-reanimated'
import Sheet from '../ui/Sheet'
import PressableScale from '../ui/PressableScale'
import { vaultErrorCopy, RETRYABLE_VAULT_ERRORS } from './vaultErrorCopy'
import { vaultKeyLabel } from './KeyChooser'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useVault,
  vaultStore,
  VAULT_INPUTS_PER_TAP,
  haptics,
  i18n,
  type CeremonyPhase,
  type VaultErrorCode
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, opts?: Record<string, unknown>) => i18n.t(k, opts) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
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

/** Swallows the sheet's dismiss while work is in flight — `Sheet` requires an
 * onClose, and cancelling mid-operation is the thing we are preventing. */
const noop = (): void => {}

const PhaseIcon: Record<CeremonyPhase, keyof IoniconsComponent['glyphMap']> = {
  idle: 'lock-closed',
  'waiting-for-key': 'hardware-chip-outline',
  connecting: 'sync-outline',
  'pin-entry': 'keypad-outline',
  'awaiting-touch': 'finger-print-outline',
  preparing: 'lock-open-outline',
  broadcasting: 'paper-plane-outline',
  armed: 'lock-open',
  error: 'alert-circle-outline'
}

export const VaultCeremonySheet: React.FC = () => {
  const { colors } = useTheme()
  const { state, submitPin, cancel, retry } = useVault()
  const reducedMotion = useReducedMotion()
  const [pin, setPin] = useState('')
  const [keyNames, setKeyNames] = useState('')
  const Ionicons = loadIonicons()

  const phase = state.phase
  // 'armed' stays hidden: it persists for the whole retention window, so
  // showing it would leave the sheet up for minutes after a transfer is done.
  const visible = phase !== 'idle' && phase !== 'armed'

  /**
   * Work is under way and there is nothing for the user to do but wait.
   *
   * The sheet is deliberately NOT dismissable here. A backdrop tap runs
   * cancel(), which mid-operation is the abandonment this progress display
   * exists to prevent — and a cancelled withdrawal can leave the vault UTXO
   * reserved. Cancel stays available while we are waiting on the user
   * (waiting-for-key, pin-entry).
   */
  const busy = phase === 'preparing' || phase === 'broadcasting'

  // Pulse the icon while waiting for the user to act (insert / touch).
  const pulse = useSharedValue(1)
  useEffect(() => {
    const active =
      phase === 'waiting-for-key' ||
      phase === 'awaiting-touch' ||
      phase === 'preparing' ||
      phase === 'broadcasting'
    if (active && !reducedMotion) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.12, { duration: 700, easing: Easing.inOut(Easing.quad) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = withTiming(1, { duration: 150 })
    }
    return () => cancelAnimation(pulse)
  }, [phase, reducedMotion, pulse])
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }))

  // Reset the PIN field whenever we (re)enter pin-entry, and focus the
  // input on a delay: `autoFocus` grabs focus before the sheet's mount/
  // layout settles, which on both platforms drops the first keystroke
  // (it lands while the native field is still wiring up).
  const pinInputRef = useRef<TextInput>(null)
  useEffect(() => {
    if (phase !== 'pin-entry') return
    setPin('')
    const timer = setTimeout(() => pinInputRef.current?.focus(), 150)
    return () => clearTimeout(timer)
  }, [phase])

  // The vault's key labels, for serial-mismatch copy. Read once per ceremony
  // (when the sheet becomes visible), never during idle: this component is
  // mounted for the app's whole life.
  useEffect(() => {
    if (!visible) return
    let alive = true
    void vaultStore
      .getMeta()
      .then(m => {
        if (alive) setKeyNames(m ? m.keys.map(vaultKeyLabel).join(', ') : '')
      })
      .catch(() => {
        if (alive) setKeyNames('')
      })
    return () => {
      alive = false
    }
  }, [visible])

  const reason = state.reason
  const errCode = state.error?.code as VaultErrorCode | undefined
  const progress = state.progress

  // Batch arithmetic (spec §4.2 step 6): at most VAULT_INPUTS_PER_TAP digests
  // per tap. `signed > 0` while waiting for a key means "between batches".
  const batches = progress ? Math.max(1, Math.ceil(progress.total / VAULT_INPUTS_PER_TAP)) : 0
  const batchIndex = progress ? Math.min(batches, Math.floor(progress.signed / VAULT_INPUTS_PER_TAP) + 1) : 0
  const betweenBatches =
    !!progress &&
    progress.signed > 0 &&
    (phase === 'waiting-for-key' || phase === 'awaiting-touch' || phase === 'connecting')

  // iOS talks to the key over NFC (a tap), Android over USB (insert + touch).
  const nfc = Platform.OS === 'ios'

  const title = (() => {
    switch (phase) {
      case 'waiting-for-key':
        return nfc ? t('vault_hold_key_nfc') : t('vault_insert_key')
      case 'connecting':
        return t('vault_reading_key')
      case 'pin-entry':
        return t('vault_enter_pin')
      case 'awaiting-touch':
        return nfc ? t('vault_keep_holding_nfc') : t('vault_touch_contact')
      case 'preparing':
        return t('vault_unlocking_funds')
      case 'broadcasting':
        return t('vault_sending_to_network')
      case 'error':
        return vaultErrorCopy(errCode, { names: keyNames || undefined })
      default:
        return ''
    }
  })()

  const iconColor = phase === 'error' ? colors.error : colors.accent

  return (
    <Sheet visible={visible} onClose={busy ? noop : cancel} title={t('vault_title')} fitContent>
      <View style={styles.body}>
        {reason ? <Text style={[styles.reason, { color: colors.textSecondary }]}>{reason}</Text> : null}

        <Animated.View style={[styles.iconWrap, { backgroundColor: colors.backgroundSecondary }, pulseStyle]}>
          {phase === 'connecting' || busy ? (
            <ActivityIndicator color={iconColor} />
          ) : (
            <Ionicons name={PhaseIcon[phase]} size={40} color={iconColor} />
          )}
        </Animated.View>

        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>

        {/* Between taps of a multi-batch signing: which batch this is, and how
            far along. The iOS system NFC sheet covers this while it is up, so
            this is what the user sees as it dismisses and before the next tap. */}
        {betweenBatches && progress && (
          <>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {t('vault_nfc_sign_batch', { b: batchIndex, n: batches })}
            </Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              {t('vault_sign_progress', { signed: progress.signed, total: progress.total })}
            </Text>
          </>
        )}

        {/* The whole point of the busy phases: say the work is real and say
            not to leave. While signatures are being gathered, say how many. */}
        {busy && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {phase === 'broadcasting'
              ? t('vault_sending_sub')
              : progress
                ? t('vault_sign_progress', { signed: progress.signed, total: progress.total })
                : t('vault_unlocking_sub')}
          </Text>
        )}

        {phase === 'awaiting-touch' && <TouchCountdown color={colors.accent} trackColor={colors.backgroundSecondary} />}

        {phase === 'pin-entry' && (
          <>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {nfc ? t('vault_pin_sub_nfc') : t('vault_pin_sub_usb')}
            </Text>
            <TextInput
              ref={pinInputRef}
              style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
              value={pin}
              onChangeText={setPin}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
            />
            {state.error?.code === 'pin-invalid' && typeof state.error.retriesLeft === 'number' && (
              <Text style={[styles.hint, { color: colors.warning }]}>
                {t('vault_pin_retries', { count: state.error.retriesLeft })}
              </Text>
            )}
            <PressableScale
              haptic="confirm"
              onPress={() => {
                if (!/^[0-9]{6,8}$/.test(pin)) return
                submitPin(pin)
                // Drop it from component state the moment it is handed over:
                // this sheet is mounted for the app's whole life, and the
                // phase effect above only clears on RE-ENTERING pin-entry.
                setPin('')
              }}
              accessibilityState={{ disabled: !/^[0-9]{6,8}$/.test(pin) }}
              style={[styles.primaryBtn, { backgroundColor: colors.accent, opacity: /^[0-9]{6,8}$/.test(pin) ? 1 : 0.4 }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_unlock_cta')}</Text>
            </PressableScale>
          </>
        )}

        {phase === 'error' && errCode === 'pin-invalid' && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {typeof state.error?.retriesLeft === 'number'
              ? t('vault_pin_invalid_retry', { count: state.error.retriesLeft })
              : t('vault_pin_invalid_retry_generic')}
          </Text>
        )}

        {phase === 'error' && (
          <View style={styles.errorActions}>
            {errCode && RETRYABLE_VAULT_ERRORS.has(errCode) && (
              <PressableScale
                haptic="confirm"
                onPress={retry}
                style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
              >
                <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_retry')}</Text>
              </PressableScale>
            )}
            <PressableScale onPress={cancel} style={styles.secondaryBtn}>
              <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_dismiss')}</Text>
            </PressableScale>
          </View>
        )}

        {(phase === 'waiting-for-key' || phase === 'awaiting-touch' || phase === 'connecting') && (
          <PressableScale onPress={cancel} style={styles.secondaryBtn}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        )}
      </View>
    </Sheet>
  )
}

/** 15-second ring that empties while the key waits for a touch. Purely a UI
 * countdown — the native touch policy enforces the real timeout. */
const TouchCountdown: React.FC<{ color: string; trackColor: string }> = ({ color, trackColor }) => {
  const reducedMotion = useReducedMotion()
  const progress = useSharedValue(1)
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (reducedMotion) return
    haptics.tap()
    progress.value = withTiming(0, { duration: 15000, easing: Easing.linear })
    return () => cancelAnimation(progress)
  }, [progress, reducedMotion])
  const style = useAnimatedStyle(() => ({ width: `${Math.max(0, progress.value) * 100}%` }))
  return (
    <View style={[styles.countdownTrack, { backgroundColor: trackColor }]}>
      <Animated.View style={[styles.countdownFill, { backgroundColor: color }, style]} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, alignItems: 'center', gap: spacing.lg },
  reason: { ...typography.subhead, textAlign: 'center' },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md
  },
  title: { ...typography.title3, textAlign: 'center' },
  subtitle: { ...typography.subhead, textAlign: 'center', marginTop: -spacing.sm },
  pin: {
    width: '70%',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  hint: { ...typography.footnote },
  primaryBtn: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondaryBtn: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  errorActions: { width: '100%', gap: spacing.sm },
  countdownTrack: { width: '80%', height: 6, borderRadius: 3, overflow: 'hidden' },
  countdownFill: { height: '100%' }
})
