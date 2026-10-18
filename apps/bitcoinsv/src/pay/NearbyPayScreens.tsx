// The nearby payer's steps after Confirm, in this app's own style (Send
// Payment's screens, app/send.tsx): sending over the radio, the show-a-code
// fallback, and done; and the payee's "payment received". The core's
// NearbyFlow owns the payment and hands each one its figures and actions
// (NearbySending, NearbyShowCode, NearbyDone, NearbyReceived).
import React, { useEffect } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, Clock, Radio, TriangleAlert, User } from 'lucide-react-native'
import { sounds } from '@bsv/expo-wallet-toolbox'
import type { NearbyDone, NearbyReceived, NearbySending, NearbyShowCode } from '@bsv/expo-wallet-toolbox/ui'
import { font, usePalette } from '../theme'
import { PageHeader } from '../ui/PageHeader'
import { GlassButton } from '../ui/GlassButton'
import { BsvMark } from '../ui/BsvMark'
import { RaisedAmount } from '../ui/RollingAmount'
import { BalancedText } from '../ui/BalancedText'
import { enter, useReducedMotion } from '../ui/motion'
import { bsvFigure } from '../activity/format'

type Asset = { ticker: string; decimals: number } | undefined
const figureOf = (units: number, asset: Asset) => (asset ? (units / 10 ** asset.decimals).toString() : bsvFigure(units))

function Face({ size = 72 }: { size?: number }) {
  const palette = usePalette()
  return (
    <View style={[styles.face, { width: size, height: size, borderRadius: size / 2, backgroundColor: palette.secondary }]}>
      <User size={size * 0.42} color={palette.mutedForeground} />
    </View>
  )
}

function Presence({ presence }: { presence: NearbySending['presence'] }) {
  const palette = usePalette()
  if (!presence) return null
  return (
    <View style={styles.presence} accessibilityRole="text">
      <Radio size={16} color={presence.state === 'qr' ? palette.mutedForeground : palette.positive} />
      <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{presence.label}</Text>
    </View>
  )
}

/** Over the radio: nothing to do but wait a moment. */
export function NearbySendingScreen({ s }: { s: NearbySending }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        {/* the header's title without its back button: there's no way back mid-send */}
        <Text accessibilityRole="header" style={[font(700), styles.title, { color: palette.foreground }]}>
          Pay nearby
        </Text>
      </View>
      <View style={styles.centre}>
        <Face />
        <Text numberOfLines={1} style={[font(600), styles.body15, { color: palette.foreground }]}>
          {s.recipient.name}
        </Text>
        <View style={styles.amount}>
          <RaisedAmount
            figure={figureOf(s.amount, s.asset)}
            unit={s.asset?.ticker}
            mark={s.asset ? undefined : m => <BsvMark size={m} />}
            size={36}
            color={palette.foreground}
          />
        </View>
        <View style={styles.sending} accessibilityRole="progressbar" accessibilityLabel="Sending">
          <ActivityIndicator color={palette.mutedForeground} />
          <Text style={[font(500), styles.small, { color: palette.mutedForeground }]}>Sending to their phone…</Text>
        </View>
        <Presence presence={s.presence} />
      </View>
    </View>
  )
}

/** No radio reached them: the payment itself, as a code they scan. */
export function NearbyShowCodeScreen({ q }: { q: NearbyShowCode }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const figure = figureOf(q.amount, q.asset)
  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Show this code" onBack={q.back} />
      </View>
      <ScrollView contentContainerStyle={[styles.codeBody, { paddingBottom: 16 }]}>
        <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
          Let {q.recipient.name} scan it to take{' '}
          <Text style={[font(600), { color: palette.foreground }]}>
            {figure} {q.asset?.ticker ?? 'BSV'}
          </Text>
        </BalancedText>
        <View style={[styles.codeCard, { boxShadow: `0 0 0 1px ${palette.border}` }]}>{q.code(244)}</View>
        {q.animated && (
          <BalancedText style={[font(400), styles.xs, styles.center, { color: palette.mutedForeground }]}>
            Hold it steady: the code plays through a few frames.
          </BalancedText>
        )}
        <Presence presence={q.presence} />
        {q.notice && (
          <View style={[styles.notice, { backgroundColor: palette.secondary }]}>
            <BalancedText style={[font(400), styles.small, { color: palette.foreground }]}>{q.notice.text}</BalancedText>
          </View>
        )}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <GlassButton size="lg" label="Done, they’ve scanned it" onPress={q.done} />
      </View>
    </View>
  )
}

/** It went. */
export function NearbyDoneScreen({ d }: { d: NearbyDone }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  useEffect(() => {
    sounds.paymentSend()
    return () => sounds.release()
  }, [])
  // a token's figure arrives formatted ("25.00 USDX"): figure and unit
  const at = d.amountText?.lastIndexOf(' ') ?? -1
  const figure = d.amountText ? (at > 0 ? d.amountText.slice(0, at) : d.amountText) : bsvFigure(d.amount)
  const unit = d.amountText && at > 0 ? d.amountText.slice(at + 1) : undefined
  const to = d.recipientName ?? 'them'
  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Payment" onBack={d.dismiss} />
      </View>
      <ScrollView contentContainerStyle={[styles.doneBody, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.done}>
          <View>
            <Face size={64} />
            <View style={[styles.doneBadge, { backgroundColor: palette.positive, boxShadow: `0 0 0 2px ${palette.background}` }]}>
              <Animated.View style={still ? null : enter({ scale: 0.5, opacity: 1, duration: 300 })}>
                <Check size={14} color="#ffffff" strokeWidth={3.2} />
              </Animated.View>
            </View>
          </View>
          <View style={styles.doneAmount}>
            <RaisedAmount figure={figure} unit={unit} mark={unit ? undefined : m => <BsvMark size={m} />} size={36} color={palette.foreground} />
          </View>
          <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>to {to}</Text>
        </View>
        <BalancedText style={[font(500), styles.small, styles.center, { color: palette.foreground }]}>
          {d.statusNote || `Sent to ${to}, phone to phone.`}
        </BalancedText>
        <View style={styles.doneButtons}>
          <GlassButton size="lg" label="Done" onPress={d.dismiss} />
        </View>
      </ScrollView>
    </View>
  )
}

/** Paid: in your wallet (or on its way there), shown full screen over Receive. */
export function NearbyReceivedScreen({ r }: { r: NearbyReceived }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  useEffect(() => {
    sounds.paymentReceive()
    return () => sounds.release()
  }, [])
  const at = r.amountText?.lastIndexOf(' ') ?? -1
  const figure = r.amountText ? (at > 0 ? r.amountText.slice(0, at) : r.amountText) : bsvFigure(r.amount)
  const unit = r.amountText && at > 0 ? r.amountText.slice(at + 1) : undefined
  // the wallet credits it a moment later: a clock until then, a warning if it didn't
  const done = r.verification === 'verified'
  const failed = r.verification === 'not-credited'
  const line = failed
    ? 'Not in your wallet yet. Check Activity before handing anything over.'
    : done
      ? r.broadcast === false
        ? 'In your wallet. Received offline, so it goes to the network once you’re online.'
        : 'In your wallet.'
      : 'Adding it to your wallet…'
  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={r.dismiss}>
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <Text accessibilityRole="header" style={[font(700), styles.title, { color: palette.foreground }]}>
            Payment received
          </Text>
        </View>
        <ScrollView contentContainerStyle={[styles.doneBody, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.done}>
            <View>
              <Face size={64} />
              <View
                style={[
                  styles.doneBadge,
                  { backgroundColor: failed ? palette.destructive : done ? palette.positive : palette.ink, boxShadow: `0 0 0 2px ${palette.background}` }
                ]}
              >
                <Animated.View style={still ? null : enter({ scale: 0.5, opacity: 1, duration: 300 })}>
                  {failed ? (
                    <TriangleAlert size={13} color="#ffffff" strokeWidth={2.8} />
                  ) : done ? (
                    <Check size={14} color="#ffffff" strokeWidth={3.2} />
                  ) : (
                    <Clock size={14} color="#ffffff" strokeWidth={2.8} />
                  )}
                </Animated.View>
              </View>
            </View>
            <View style={styles.doneAmount}>
              <RaisedAmount figure={figure} unit={unit} sign="+" mark={unit ? undefined : m => <BsvMark size={m} />} size={36} color={palette.positive} />
            </View>
            {!!r.payerName && <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>from {r.payerName}</Text>}
          </View>
          <BalancedText style={[font(500), styles.small, styles.center, { color: failed ? palette.destructive : palette.foreground }]}>{line}</BalancedText>
          {!!r.statusNote && (
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>{r.statusNote}</BalancedText>
          )}
          <View style={styles.doneButtons}>
            <GlassButton size="lg" label="Done" onPress={r.dismiss} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  // PageHeader's bar: 36 tall plus 12 above and below, the title 20/28
  title: { textAlign: 'center', fontSize: 20, lineHeight: 28, letterSpacing: -0.5, paddingVertical: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 80 },
  face: { alignItems: 'center', justifyContent: 'center' },
  amount: { paddingTop: 8 },
  sending: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 16 },
  presence: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  codeBody: { gap: 16, paddingHorizontal: 16, paddingTop: 8, alignItems: 'center' },
  codeCard: { backgroundColor: '#ffffff', borderRadius: 24, padding: 16 },
  notice: { alignSelf: 'stretch', borderRadius: 16, padding: 14 },
  footer: { gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  doneBody: { gap: 16, paddingHorizontal: 16 },
  done: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  doneBadge: { position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  doneAmount: { paddingTop: 8 },
  doneButtons: { gap: 8, paddingTop: 8 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  center: { textAlign: 'center', alignSelf: 'stretch' }
})
