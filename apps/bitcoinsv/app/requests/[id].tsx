// A payment request (the prototype's request in activity/[id]), receipt-style
// like a payment: who asked whom and when, the amount large, where it stands,
// then the facts under a dashed rule, settling in one after another. Theirs:
// pay it (Send, with the request's pay link) or decline it. Yours: remind them
// or cancel it. Either side's choice reaches the other wallet (src/requests).
import React, { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { showToast } from '../../src/ui/Toast'
import { font, radii, usePalette } from '../../src/theme'
import { Face } from '../../src/ui/Face'
import { GlassButton } from '../../src/ui/GlassButton'
import { PageHeader } from '../../src/ui/PageHeader'
import { RaisedAmount } from '../../src/ui/RollingAmount'
import { BsvMark } from '../../src/ui/BsvMark'
import { CoinMark } from '../../src/ui/CoinMark'
import { enter, useReducedMotion } from '../../src/ui/motion'
import { bsvFigure, whenLabel } from '../../src/activity/format'
import { requestTitle } from '../../src/requests/RequestRow'
import { useContacts } from '../../src/contacts/useContacts'
import { amountText, useRequests } from '../../src/requests/useRequests'
import { selfNamed, whoLabel } from '../../src/requests/requests'

const STATE = {
  pending: { out: 'Waiting for them to pay', in: 'Waiting for you to pay' },
  paid: { out: 'Paid', in: 'You paid this' },
  declined: { out: 'They declined it', in: 'You declined it' },
  cancelled: { out: 'You cancelled it', in: 'They cancelled it' }
} as const

/** The pill under the amount, as a payment's (activity/[id]/page.tsx). */
const PILL = { pending: 'Awaiting payment', paid: 'Paid', declined: 'Declined', cancelled: 'Cancelled' } as const

/** The payment receipt's entrance: rise 4px and fade, 400ms ease-out, 60 + i·45ms apart. */
const stagger = (i: number) => enter({ opacity: 0, translateY: 4, duration: 400, delay: 60 + i * 45, easing: 'ease-out' })

export default function RequestDetail() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { requests, remind, cancel, decline } = useRequests()
  const contacts = useContacts()
  const [busy, setBusy] = useState(false)
  // motion-reduce:animate-none
  const still = useReducedMotion()
  const rise = (i: number) => (still ? null : stagger(i))
  const r = requests.find(x => x.id === id)

  if (!r) {
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Request" />
        </View>
      </View>
    )
  }

  const contact = contacts.byKey.get(r.counterparty.toLowerCase())
  const who = whoLabel(r, contact?.name)
  const first = who.split(' ')[0]
  const amount = amountText(r)
  const open = r.status === 'pending'
  const dollar = !!r.asset && /usd/i.test(r.asset.ticker)
  const figure = r.asset ? (r.units / 10 ** r.asset.decimals).toString() : bsvFigure(r.units)

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await run()
      showToast(done, { type: 'success' })
    } catch {
      showToast('That didn’t go through. Try again in a moment.', { type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Request" />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {/* who and when */}
        <Animated.View style={[styles.who, rise(0)]}>
          <Face counterparty={{ kind: 'identityKey', value: r.counterparty }} avatarUrl={contact?.cachedAvatarUrl} size={72} />
          <Text style={[font(700), styles.title, { color: palette.foreground }]}>{requestTitle(r, contact?.name)}</Text>
          <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{whenLabel(r.createdAt)}</Text>
          {selfNamed(r, contact?.name) && (
            <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{selfNamed(r, contact?.name)} · not in your contacts</Text>
          )}
        </Animated.View>

        {/* amount, and where it stands */}
        <Animated.View style={[styles.amountBlock, rise(1)]} accessible accessibilityLabel={`${amount}, ${PILL[r.status]}`}>
          <RaisedAmount
            figure={figure}
            unit={r.asset && !dollar ? r.asset.ticker : undefined}
            mark={r.asset ? (dollar ? sz => <CoinMark coin={{ kind: 'token', ticker: r.asset!.ticker }} size={sz} /> : undefined) : sz => <BsvMark size={sz} />}
            size={48}
            color={palette.foreground}
          />
          <View style={[styles.pill, { backgroundColor: r.status === 'paid' ? palette.foreground + '1a' : palette.secondary }]}>
            <Text style={[font(600), styles.small, { color: r.status === 'paid' ? palette.foreground : palette.mutedForeground }]}>{PILL[r.status]}</Text>
          </View>
        </Animated.View>

        <Animated.View style={[styles.rule, { borderColor: palette.border }, rise(2)]} />

        {/* facts */}
        <View style={styles.facts}>
          {[
            { l: 'Status', v: open && r.direction === 'out' && r.claimedPaidAt ? 'They say they’ve paid: not arrived yet' : STATE[r.status][r.direction] },
            { l: 'Asked', v: whenLabel(r.createdAt) },
            ...(r.settledAt && !open ? [{ l: r.status === 'paid' ? 'Paid' : 'Closed', v: whenLabel(r.settledAt) }] : []),
            ...(r.note ? [{ l: 'Note', v: r.note }] : [])
          ].map((f, i) => (
            <Animated.View key={f.l} style={[styles.fact, rise(3 + i)]}>
              <Text style={[font(400), styles.small, styles.factLabel, { color: palette.mutedForeground }]}>{f.l}</Text>
              <Text style={[font(500), styles.small, styles.value, { color: palette.foreground }]}>{f.v}</Text>
            </Animated.View>
          ))}
        </View>
      </ScrollView>
      {open && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          {r.direction === 'in' ? (
            <>
              <GlassButton
                size="lg"
                label={`Pay ${amount}`}
                disabled={busy}
                onPress={() => router.push({ pathname: '/send', params: { link: r.link, request: r.id, ...(r.note ? { note: r.note } : {}) } })}
              />
              <GlassButton size="lg" variant="outline" label="Decline" disabled={busy} onPress={() => void act(() => decline(r.id), `${first} will see you declined`)} />
            </>
          ) : (
            <>
              <GlassButton size="lg" label={`Remind ${first}`} disabled={busy} onPress={() => void act(() => remind(r.id), `${first} got a reminder`)} />
              <GlassButton size="lg" variant="outline" label="Cancel request" disabled={busy} onPress={() => void act(() => cancel(r.id), 'Request cancelled')} />
            </>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  who: { alignItems: 'flex-start', gap: 4, paddingTop: 16 },
  title: { paddingTop: 16, fontSize: 24, lineHeight: 32, letterSpacing: -0.6 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  amountBlock: { alignItems: 'flex-start', gap: 12, paddingTop: 28 },
  pill: { borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 6 },
  rule: { marginVertical: 28, borderTopWidth: 1, borderStyle: 'dashed' },
  facts: { gap: 20, paddingBottom: 16 },
  fact: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  factLabel: { flexShrink: 0 },
  value: { flexShrink: 1, textAlign: 'right' },
  footer: { gap: 8, paddingHorizontal: 16 }
})
