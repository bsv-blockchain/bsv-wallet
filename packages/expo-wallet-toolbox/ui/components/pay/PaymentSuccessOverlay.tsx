/**
 * The moment money arrives.
 *
 * Full screen, and it stays until the person receiving taps Done. That is the
 * whole point: a toast is the right weight for "your settings were saved" and
 * the wrong weight for "someone just paid you" — it can be missed entirely if
 * the phone is face down, in a pocket, or simply not being looked at when it
 * fires, and the one thing a payee must never be unsure about is whether the
 * money arrived. Requiring an acknowledgement means the event cannot be missed,
 * only dismissed.
 *
 * Presentational only. It reports nothing and decides nothing — by the time it
 * mounts the payment is already credited, so dismissing it cannot affect money.
 *
 * Staged in three beats, as the nearby flow's success screen is: the amount is
 * already on screen when the mark begins drawing, the mark fires the success
 * haptic from inside Celebration, then the tone sounds. Firing them together
 * reads as one blunt event and buries the figure, which is the thing that
 * actually matters.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Modal, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { useTranslation } from 'react-i18next'

import { useTheme, durations, springs, spacing, typography, radii, sounds } from '@bsv/expo-wallet-toolbox'
import AmountDisplay from '../wallet/AmountDisplay'
import Celebration from '../ui/Celebration'
import PressableScale from '../ui/PressableScale'
import type { DismissTarget } from '../../dismissTarget'

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's and WalletHomeScreen.tsx's lazy
 * expo-router load.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/** Beat two: the tone, just behind the mark. Sequencing, not animation. */
const TONE_DELAY_MS = 120

export interface ReceivedOverlayProps {
  /** Total satoshis credited (received) or paid (sent) in this event. */
  amount: number
  /** How many payments made up that total. Only shown when it is more than one. */
  count?: number
  /**
   * False when the payment was accepted with no network and has not reached a
   * broadcaster yet. The money is credited and spendable either way; what is
   * unsettled is whether anyone but these two devices has seen it, and the
   * payee is entitled to know that before treating it as final.
   */
  broadcast?: boolean
  /**
   * Which way the money moved. The staging is identical — that is the point of
   * sharing this screen across every rail — only the words change: 'received'
   * says the money is in the wallet; 'sent' names who it went to.
   */
  direction?: 'received' | 'sent'
  /** Sent only: the resolved counterparty (name, handle, or abbreviated address). */
  recipientName?: string
  /**
   * Token mode: the figure in the asset's own units, already formatted
   * ("25.00 USDX"). It replaces the satoshi figure entirely — `AmountDisplay`
   * would read `settings.currency` and print a token amount as satoshis or,
   * worse, cross it into fiat at the BSV rate.
   */
  amountText?: string
  /**
   * One already-interpolated line about what has and has not happened yet:
   * "Settling with Acme Bank", "not yet confirmed by Acme Bank", "we couldn't
   * tell them yet". Never a claim of settlement the wallet does not have.
   */
  statusNote?: string
  /**
   * First time this wallet has ever held this asset: who issues it and what
   * they can do. Disclosure at the one moment the user is definitely looking.
   */
  firstHoldNote?: string
  /**
   * Where acknowledging the overlay sends the user. Defaults to `/`, the
   * wallet's own home route. A host that embeds the wallet as a sub-screen
   * (rather than as the app root) should pass its own wallet-home route here.
   */
  dismissTo?: DismissTarget
  /**
   * Sent only, and only when the recipient resolved to an identity key that
   * is not already a saved contact: offers a "Save as a contact" text
   * action under the recipient's name. The caller owns the whole action (cleanup and
   * navigation both) — this component stays presentational and only decides
   * whether to show the button at all.
   */
  onAddContact?: () => void
  /**
   * Acknowledged. The only way this screen closes. Clean up local state here —
   * the overlay itself then returns the user to the wallet, so the updated
   * balance is the next thing they see.
   */
  onDismiss: () => void
}

export default function PaymentSuccessOverlay({
  amount,
  count = 1,
  broadcast = true,
  direction = 'received',
  recipientName,
  amountText,
  statusNote,
  firstHoldNote,
  dismissTo = '/',
  onAddContact,
  onDismiss
}: ReceivedOverlayProps) {
  const sent = direction === 'sent'
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { router } = loadExpoRouter()
  const reducedMotion = useReducedMotion()

  /**
   * The button appears once the mark has landed. It is not a gate — nothing is
   * pending — but a Done button already on screen while a checkmark is still
   * drawing invites a tap through the moment it exists to deliver.
   */
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Returns immediately and cannot throw, so a device with no audio session
    // simply gets the payment quietly.
    const tone = setTimeout(() => (sent ? sounds.paymentSend() : sounds.paymentReceive()), TONE_DELAY_MS)
    return () => clearTimeout(tone)
  }, [])

  // Hand the shared player back; a payee may leave this screen up on a counter.
  useEffect(() => () => sounds.release(), [])

  const onMarkDone = useCallback(() => setReady(true), [])

  /**
   * Done means "back to the wallet", uniformly: a completed payment in either
   * direction ends on the balance it changed, and the wallet refetches balance
   * and activity on focus.
   *
   * `dismissTo`, NOT `navigate`. Both land on the wallet, but only one of them
   * clears the flow behind it. A bare NAVIGATE onto a route already in the
   * stack does not walk back to it — StackRouter filters that route out and
   * re-pushes it on top, so `[wallet, pay, address-send]` becomes
   * `[pay, address-send, wallet]` and the finished payment is still sitting
   * under the user's thumb: one edge-swipe back into a flow they completed.
   * POP_TO (`dismissTo`) truncates at the target instead, leaving just
   * `[wallet]`, so back from here is the wallet screen and nothing else.
   */
  const acknowledge = useCallback(() => {
    onDismiss()
    router.dismissTo(dismissTo)
  }, [onDismiss, dismissTo])

  const settleIn = reducedMotion
    ? undefined
    : FadeInDown.springify()
        .mass(springs.snappy.mass)
        .damping(springs.snappy.damping)
        .stiffness(springs.snappy.stiffness)
  const fadeIn = reducedMotion ? undefined : FadeIn.duration(durations.quick)

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      // No onRequestClose handler that dismisses: Android's back button must not
      // be able to clear this without the acknowledgement being deliberate.
      onRequestClose={() => {}}
    >
      <View
        style={[styles.container, { backgroundColor: colors.background }]}
        accessibilityViewIsModal
        accessibilityRole="alert"
        accessibilityLabel={sent ? t('local_pay_sent') : `${t('local_pay_received')}. ${t('local_pay_added')}`}
      >
        <View style={styles.stage}>
          <Celebration onDone={onMarkDone} />
          <View style={styles.gapXl} />

          <Text style={[styles.title, { color: colors.textPrimary }]} textBreakStrategy="balanced">
            {t(sent ? 'local_pay_sent' : 'local_pay_received')}
          </Text>

          {/* The focal element. Everything else on this screen is a label. */}
          <Animated.View entering={settleIn} style={styles.amountBlock}>
            <Text
              style={[styles.amount, { color: colors.textPrimary }]}
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              adjustsFontSizeToFit
              accessibilityRole="text"
            >
              {amountText ?? <AmountDisplay>{amount}</AmountDisplay>}
            </Text>
          </Animated.View>

          {sent ? (
            <>
              {!!recipientName && (
                <Text
                  style={[styles.support, { color: colors.textSecondary }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {t('pay_sent_to', { name: recipientName })}
                </Text>
              )}
              {/* A text button under the name, not a second filled control: Done
                  stays the one accent-filled control on this screen. */}
              {!!onAddContact && (
                <PressableScale
                  onPress={onAddContact}
                  haptic="tap"
                  style={styles.saveContact}
                  accessibilityRole="button"
                  accessibilityLabel={t('pay_save_as_contact')}
                >
                  <Text style={[styles.saveContactText, { color: colors.accent }]}>{t('pay_save_as_contact')}</Text>
                </PressableScale>
              )}
            </>
          ) : (
            <Text style={[styles.support, { color: colors.success }]} textBreakStrategy="balanced">
              {count > 1 ? t('local_pay_added_multiple', { count }) : t('local_pay_added')}
            </Text>
          )}

          {/* `pay_received_not_broadcast` is the RECEIVED-side sentence and was
              rendered ungated by direction; a sent payment gets its own, because
              "Received offline" over an outgoing payment is simply wrong. */}
          {!broadcast && (
            <Text style={[styles.pending, { color: colors.textSecondary }]}>
              {t(sent ? 'pay_sent_not_broadcast' : 'pay_received_not_broadcast')}
            </Text>
          )}

          {!!statusNote && <Text style={[styles.pending, { color: colors.textSecondary }]}>{statusNote}</Text>}

          {!!firstHoldNote && (
            <Text
              style={[styles.pending, styles.firstHold, { color: colors.textSecondary }]}
              textBreakStrategy="balanced"
            >
              {firstHoldNote}
            </Text>
          )}
        </View>

        {ready && (
          <Animated.View entering={fadeIn} style={styles.footer}>
            <PressableScale
              onPress={acknowledge}
              haptic="tap"
              style={[styles.button, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={t('done')}
            >
              <Text style={[styles.buttonText, { color: colors.textOnAccent }]}>{t('done')}</Text>
            </PressableScale>
          </Animated.View>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxxl
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  gapXl: {
    height: spacing.xl
  },
  title: {
    ...typography.title2,
    fontWeight: '700',
    textAlign: 'center'
  },
  amountBlock: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    alignSelf: 'stretch',
    alignItems: 'center'
  },
  amount: {
    fontSize: 44,
    lineHeight: 52,
    fontWeight: '700',
    textAlign: 'center'
  },
  support: {
    ...typography.subhead,
    textAlign: 'center'
  },
  pending: {
    ...typography.footnote,
    textAlign: 'center',
    marginTop: spacing.xs
  },
  firstHold: {
    marginTop: spacing.lg,
    maxWidth: 300
  },
  footer: {
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  buttonText: {
    ...typography.headline,
    fontWeight: '600'
  },
  saveContact: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center'
  },
  saveContactText: {
    ...typography.footnote,
    fontWeight: '600'
  }
})
