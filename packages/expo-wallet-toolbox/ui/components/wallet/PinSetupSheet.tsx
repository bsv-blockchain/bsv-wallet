/**
 * Setting a PIN, and changing one.
 *
 * Three steps at most: prove the old PIN (only when changing), choose a new
 * one, type it again. The confirm step is not ceremony — a mistyped PIN that
 * nobody notices until the next cold start is a wallet the owner cannot open,
 * and the recovery phrase is the only way back from that.
 *
 * Dismissable, unlike PinUnlockSheet: nothing is at stake until the last step
 * commits, and a user who opened this by accident from Settings should be able
 * to back out.
 */
import React, { useCallback, useState } from 'react'
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography } from '@bsv/expo-wallet-toolbox'
import { changePin, PIN_MAX_DIGITS, setPin } from '../../../core/services/secrets'
import CustomSafeArea from '../ui/CustomSafeArea'
import PressableScale from '../ui/PressableScale'
import PinPad from './PinPad'

const PIN_LENGTH = PIN_MAX_DIGITS

type Step = 'old' | 'new' | 'confirm'

export const PinSetupSheet: React.FC<{
  visible: boolean
  /** Changing an existing PIN rather than setting a first one. */
  mode: 'set' | 'change'
  onDone: () => void
  onCancel: () => void
}> = ({ visible, mode, onDone, onCancel }) => {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>(mode === 'change' ? 'old' : 'new')
  const [value, setValue] = useState('')
  const [oldPin, setOldPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setStep(mode === 'change' ? 'old' : 'new')
    setValue('')
    setOldPin('')
    setFirstPin('')
    setError(null)
  }, [mode])

  const cancel = useCallback(() => {
    reset()
    onCancel()
  }, [reset, onCancel])

  const complete = useCallback(
    async (pin: string) => {
      setError(null)

      if (step === 'old') {
        // Not verified here — `changePin` does that against the wrap itself, so
        // there is no second place that could disagree about what is correct.
        setOldPin(pin)
        setValue('')
        setStep('new')
        return
      }

      if (step === 'new') {
        setFirstPin(pin)
        setValue('')
        setStep('confirm')
        return
      }

      if (pin !== firstPin) {
        setValue('')
        setFirstPin('')
        setStep('new')
        setError(t('pin_error_mismatch'))
        return
      }

      setBusy(true)
      let ok = false
      try {
        ok = mode === 'change' ? await changePin(oldPin, pin) : await setPin(pin)
      } finally {
        setBusy(false)
      }

      if (!ok) {
        // The only way `changePin` fails after a matching confirm is a wrong
        // old PIN, so send the user back to that step rather than to this one.
        reset()
        setError(mode === 'change' ? t('pin_error_wrong_old') : t('pin_error_failed'))
        return
      }

      reset()
      onDone()
    },
    [step, firstPin, mode, oldPin, reset, onDone, t]
  )

  if (!visible) return null

  const title =
    step === 'old' ? t('pin_current_title') : step === 'new' ? t('pin_new_title') : t('pin_confirm_title')
  const subtitle =
    step === 'old' ? t('pin_current_subtitle') : step === 'new' ? t('pin_new_subtitle') : t('pin_confirm_subtitle')

  return (
    <Modal
      visible
      animationType="slide"
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
      onRequestClose={cancel}
    >
      <CustomSafeArea style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={styles.body}>
          <PinPad
            value={value}
            onChange={setValue}
            length={PIN_LENGTH}
            onComplete={complete}
            title={title}
            subtitle={subtitle}
            error={error}
            disabled={busy}
            footer={
              busy ? (
                <ActivityIndicator color={colors.textSecondary} />
              ) : (
                <PressableScale haptic="tap" onPress={cancel} style={styles.alt}>
                  <Text style={[styles.altLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                </PressableScale>
              )
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
  altLabel: { ...typography.body }
})

export default PinSetupSheet
