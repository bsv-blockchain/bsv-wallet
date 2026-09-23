/**
 * The PIN gate, shown whenever the KEK is reachable but only by entering it.
 *
 * Blocking and undismissable by design. Everything behind it is ciphertext, so
 * there is no useful screen to fall back to — unlike the biometric advisory,
 * which interrupts a user who already has a working wallet, this IS the way in.
 *
 * Two things it must get right beyond taking six digits:
 *
 *   - The throttle has to be *visible*. A pad that silently swallows taps
 *     reads as a broken app; a pad that says "try again in 4:58" reads as a
 *     lock, which is what it is.
 *   - Face ID stays one tap away whenever this install still has it, because
 *     arriving here after a cancelled or failed ceremony is the common case,
 *     not the PIN-only one.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography, i18n } from '@bsv/expo-wallet-toolbox'
import {
  lockRemainingMs,
  unlockKek,
  unlockWithPin,
  type UnlockState
} from '../../../core/services/secrets'
import { PIN_MAX_DIGITS } from '../../../core/services/secrets'
import CustomSafeArea from '../ui/CustomSafeArea'
import PressableScale from '../ui/PressableScale'
import PinPad from './PinPad'

/** Fixed-length entry, so the pad can submit on the last digit with no Done
 * button — and so the number of dots never reveals how long the PIN is. */
const PIN_LENGTH = PIN_MAX_DIGITS

function formatWait(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

export const PinUnlockSheet: React.FC<{
  visible: boolean
  /** Whether to offer the biometric route. False on a PIN-only install. */
  biometricAvailable?: boolean
  onUnlocked?: () => void
}> = ({ visible, biometricAvailable = false, onUnlocked }) => {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitMs, setWaitMs] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  /* Count the throttle down live. A static "try again later" leaves the user
     tapping to find out whether it has expired, which is exactly the loop the
     delay is supposed to make unappealing. */
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const tick = async () => {
      const ms = await lockRemainingMs()
      if (!cancelled) setWaitMs(ms)
    }
    void tick()
    timer.current = setInterval(tick, 1000)
    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
    }
  }, [visible])

  const submit = useCallback(
    async (pin: string) => {
      setBusy(true)
      setError(null)
      let next: UnlockState
      try {
        next = await unlockWithPin(pin)
      } finally {
        setBusy(false)
      }
      if (next.status === 'unlocked') {
        setValue('')
        onUnlocked?.()
        return
      }
      // Anything else is a refusal. Clear the pad so the next attempt starts
      // clean rather than making the user backspace six times.
      setValue('')
      const owed = next.status === 'needs-pin' ? next.retryAfterMs : 0
      setWaitMs(owed)
      setError(owed > 0 ? t('pin_error_throttled', { wait: formatWait(owed) }) : t('pin_error_wrong'))
    },
    [onUnlocked, t]
  )

  const useBiometrics = useCallback(async () => {
    setBusy(true)
    try {
      const next = await unlockKek(i18n.t('biometric_unlock_wallet'))
      if (next.status === 'unlocked') onUnlocked?.()
    } finally {
      setBusy(false)
    }
  }, [onUnlocked])

  const throttled = waitMs > 0
  const subtitle = useMemo(() => {
    if (throttled) return t('pin_error_throttled', { wait: formatWait(waitMs) })
    return t('pin_unlock_subtitle')
  }, [throttled, waitMs, t])

  if (!visible) return null

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
      // No onRequestClose handler: Android's back button must not dismiss the
      // one screen standing between the user and their keys.
      onRequestClose={() => {}}
    >
      <CustomSafeArea style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={styles.body}>
          <PinPad
            value={value}
            onChange={setValue}
            length={PIN_LENGTH}
            onComplete={submit}
            title={t('pin_unlock_title')}
            subtitle={subtitle}
            error={error}
            disabled={busy || throttled}
            footer={
              busy ? (
                <ActivityIndicator color={colors.textSecondary} />
              ) : biometricAvailable ? (
                <PressableScale haptic="tap" onPress={useBiometrics} style={styles.alt}>
                  <Text style={[styles.altLabel, { color: colors.accent }]}>
                    {t('pin_use_biometrics')}
                  </Text>
                </PressableScale>
              ) : null
            }
          />
        </View>
      </CustomSafeArea>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  alt: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  altLabel: { ...typography.headline }
})

export default PinUnlockSheet
