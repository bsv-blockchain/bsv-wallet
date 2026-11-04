import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { WalletInterface } from '@bsv/sdk'
import type { ThemeColors } from '../../../core/theme/ThemeContext'
import { hitTargets, spacing, typography } from '../../../core/theme/tokens'
import { releaseImportedOutboxEntry, validateImportedOutboxEntry, type OutboxEntry } from '../../../core/peerpay/outbox'
import PressableScale from '../ui/PressableScale'

interface Props {
  entry: OutboxEntry
  storage: Parameters<typeof releaseImportedOutboxEntry>[0] | null | undefined
  wallet: Pick<WalletInterface, 'getPublicKey'> | null
  adminOriginator: string
  colors: Pick<ThemeColors, 'textPrimary' | 'textSecondary' | 'accent' | 'separator'>
  t: (key: string, values?: Record<string, string | number>) => string
  disabled: boolean
  onApproved: (entry: OutboxEntry) => void | Promise<void>
  onCancel: () => void
  onError: (error: unknown) => void | Promise<void>
}

/** Inline approval stays in the Activity window protected by obscured-touch
 * filtering. Never offer imported display fields before signed-output validation. */
export default function ImportedOutboxApproval({
  entry,
  storage,
  wallet,
  adminOriginator,
  colors,
  t,
  disabled,
  onApproved,
  onCancel,
  onError
}: Props) {
  const [reviewed, setReviewed] = useState<OutboxEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const inFlight = useRef<object | null>(null)
  useEffect(() => {
    epoch.current++
    inFlight.current = null
    setReviewed(null)
    setBusy(false)
    return () => {
      epoch.current++
      inFlight.current = null
    }
  }, [entry.id, wallet, storage, adminOriginator])

  const proceed = async () => {
    if (disabled || !wallet || !storage || inFlight.current) return
    const attempt = {}
    const version = epoch.current
    const current = () => version === epoch.current
    inFlight.current = attempt
    setBusy(true)
    try {
      if (!reviewed) {
        const checked = await validateImportedOutboxEntry(entry, wallet, adminOriginator)
        if (current()) setReviewed(checked)
      } else {
        const approved = await releaseImportedOutboxEntry(storage, reviewed, wallet, adminOriginator)
        if (!current()) return
        setReviewed(null)
        await onApproved(approved)
      }
    } catch (error) {
      if (current()) {
        setReviewed(null)
        await onError(error)
      }
    } finally {
      if (inFlight.current === attempt) {
        inFlight.current = null
        setBusy(false)
      }
    }
  }
  const cancel = () => {
    if (disabled || !wallet || !storage || inFlight.current) return
    if (reviewed) setReviewed(null)
    else onCancel()
  }
  const inactive = disabled || busy || !wallet || !storage
  return (
    <View>
      {reviewed && (
        <Text style={[styles.detail, { color: colors.textPrimary }]}>
          {t('review_imported_payment_detail', { amount: reviewed.token.amount, recipient: reviewed.recipient })}
        </Text>
      )}
      <View style={[styles.buttons, { borderTopColor: colors.separator }]}>
        <PressableScale
          onPress={cancel}
          disabled={inactive}
          haptic="tap"
          style={[styles.button, { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator }]}
        >
          <Text style={[styles.label, { color: colors.textSecondary }]}>{t('cancel')}</Text>
        </PressableScale>
        <PressableScale onPress={() => void proceed()} disabled={inactive} haptic="tap" style={styles.button}>
          {busy ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={[styles.label, { color: colors.accent }]}>
              {t(reviewed ? 'send' : 'review_imported_payment')}
            </Text>
          )}
        </PressableScale>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  detail: { ...typography.caption1, marginBottom: spacing.sm },
  buttons: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: -spacing.lg,
    marginBottom: -spacing.md
  },
  button: {
    flex: 1,
    minHeight: hitTargets.minimum,
    minWidth: hitTargets.minimum,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center'
  },
  label: { ...typography.subhead, fontWeight: '600' }
})
