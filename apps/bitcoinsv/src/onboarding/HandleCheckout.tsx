// Paying for a handle you picked (the prototype's HandleCheckout and its
// BillingPicker / PayMethodList, components/wallet-switcher.tsx and
// pay-methods.tsx): monthly or yearly (two months free), pay with BitcoinSV
// or a card, the terms in place.
//
// Payments aren't connected yet (decision 7: placeholder BSV / Stripe
// capture). Pay never pretends to charge: it says so, and offers to create
// the wallet with the free handle instead.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, CreditCard, Info } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { BsvMark } from '../ui/BsvMark'
import { GlassButton } from '../ui/GlassButton'
import { formatPrice } from '../handles/rules'

const TERMS = (fallback: string) => [
  'Paid in advance, monthly or yearly. A year costs ten months.',
  'Cancel anytime; the handle stays yours until the paid period ends.',
  `If a payment fails or you cancel, there's a 14-day grace period. After that the handle is released and this wallet becomes @${fallback}.`,
  'Payments to a released handle no longer reach you, and anyone can buy it.',
  'Move a handle between your wallets, or release it, in Settings → Handles.',
  "Handles that impersonate someone or break the law can be withdrawn. Part periods aren't refunded."
]

type Method = 'bsv' | 'card'

export function HandleCheckout({
  open,
  onOpenChange,
  handle,
  fallback,
  monthly,
  yearly,
  onUseFree
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  handle: string
  /** the free handle the wallet gets instead */
  fallback: string
  monthly: number
  yearly: number
  onUseFree: () => void
}) {
  const palette = usePalette()
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('yearly')
  const [method, setMethod] = useState<Method>('card')
  const [view, setView] = useState<'pay' | 'terms' | 'unavailable'>('pay')
  const price = billing === 'monthly' ? monthly : yearly

  return (
    <BottomSheet
      open={open}
      onOpenChange={o => {
        if (!o) setView('pay')
        onOpenChange(o)
      }}
      onBack={() => (view === 'pay' ? onOpenChange(false) : setView('pay'))}
      title={view === 'terms' ? 'Handle terms' : `Get @${handle}`}
      description={view === 'terms' ? 'The short version.' : `${handle.length} characters · yours for as long as you keep it`}
    >
      {view === 'terms' ? (
        <View style={styles.terms}>
          {TERMS(fallback).map(t => (
            <View key={t} style={styles.term}>
              <View style={[styles.bullet, { backgroundColor: palette.mutedForeground + '99' }]} />
              <Text style={[font(400), styles.termText, { color: palette.foreground }]}>{t}</Text>
            </View>
          ))}
        </View>
      ) : view === 'unavailable' ? (
        <>
          <View style={[styles.notice, { backgroundColor: palette.secondary }]}>
            <Info size={18} color={palette.foreground} />
            <Text style={[font(400), styles.noticeText, { color: palette.foreground }]}>
              Paying for handles isn’t switched on yet, so nothing was charged. You can start with your free handle,{' '}
              <Text style={font(700)}>@{fallback}</Text>, and get @{handle} once payments are live.
            </Text>
          </View>
          <GlassButton size="lg" label={`Create wallet as @${fallback}`} onPress={onUseFree} />
          <GlassButton size="lg" variant="outline" label="Back" onPress={() => setView('pay')} />
        </>
      ) : (
        <>
          {/* monthly or yearly, two months free */}
          <View accessibilityRole="radiogroup" accessibilityLabel="Billing" style={styles.billing}>
            {(
              [
                { id: 'monthly', label: 'Monthly', price: formatPrice(monthly), per: '/month' },
                { id: 'yearly', label: 'Yearly', price: formatPrice(yearly), per: '/year' }
              ] as const
            ).map(o => {
              const on = billing === o.id
              return (
                <Pressable
                  key={o.id}
                  onPress={() => setBilling(o.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={[styles.plan, { boxShadow: on ? `0 0 0 2px ${palette.foreground}` : `0 0 0 1px ${palette.border}` }]}
                >
                  <Text style={[font(400), styles.planLabel, { color: palette.mutedForeground }]}>{o.label}</Text>
                  <Text style={[font(700), styles.planPrice, { color: palette.foreground }]}>
                    {o.price}
                    <Text style={[font(500), styles.planPer, { color: palette.mutedForeground }]}>{o.per}</Text>
                  </Text>
                  {o.id === 'yearly' && (
                    <View style={[styles.free, { backgroundColor: palette.gold }]}>
                      <Text style={[font(700), styles.freeText, { color: palette.goldForeground }]}>2 months free</Text>
                    </View>
                  )}
                </Pressable>
              )
            })}
          </View>

          <View accessibilityRole="radiogroup" accessibilityLabel="Pay with" style={styles.methods}>
            <Text style={[font(600), styles.methodsLabel, { color: palette.mutedForeground }]}>PAY WITH</Text>
            {(
              [
                { id: 'bsv', title: 'BitcoinSV from this wallet', detail: 'Add money first: a new wallet starts empty', icon: <BsvMark size={32} /> },
                {
                  id: 'card',
                  title: 'Card',
                  detail: 'Debit or credit card',
                  icon: (
                    <View style={[styles.cardIcon, { backgroundColor: palette.secondary }]}>
                      <CreditCard size={16} color={palette.foreground} />
                    </View>
                  )
                }
              ] as const
            ).map(m => {
              const on = method === m.id
              return (
                <Pressable
                  key={m.id}
                  onPress={() => setMethod(m.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => [styles.method, pressed && { backgroundColor: palette.secondary + '99' }]}
                >
                  {m.icon}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font(600), styles.methodTitle, { color: palette.foreground }]}>{m.title}</Text>
                    <Text style={[font(400), styles.methodDetail, { color: palette.mutedForeground }]}>{m.detail}</Text>
                  </View>
                  <View style={[styles.radio, on ? { backgroundColor: palette.ink, boxShadow: `0 0 0 1px ${palette.ink}` } : { boxShadow: `0 0 0 1px ${palette.border}` }]}>
                    {on && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
                  </View>
                </Pressable>
              )
            })}
          </View>

          <GlassButton size="lg" label={`Pay ${formatPrice(price)} and create wallet`} onPress={() => setView('unavailable')} />
          <Text style={[font(400), styles.renews, { color: palette.mutedForeground }]}>
            Renews {billing === 'monthly' ? 'monthly' : 'yearly'}, cancel anytime.{' '}
            <Text onPress={() => setView('terms')} style={[font(600), { color: palette.foreground, textDecorationLine: 'underline' }]}>
              Terms apply
            </Text>
          </Text>
        </>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  terms: { gap: 12, paddingBottom: 8 },
  term: { flexDirection: 'row', gap: 10 },
  bullet: { marginTop: 8, width: 6, height: 6, borderRadius: 3 },
  termText: { flex: 1, fontSize: 14, lineHeight: 22.75 },
  notice: { flexDirection: 'row', gap: 10, borderRadius: 16, padding: 14 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 21 },
  billing: { flexDirection: 'row', gap: 8, paddingTop: 8 },
  plan: { flex: 1, gap: 2, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  planLabel: { fontSize: 12, lineHeight: 16 },
  planPrice: { fontSize: 18, lineHeight: 28, fontVariant: ['tabular-nums'] },
  planPer: { fontSize: 12 },
  free: { position: 'absolute', top: -8, right: 12, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  freeText: { fontSize: 10, lineHeight: 14 },
  methods: { marginHorizontal: -8 },
  methodsLabel: { paddingHorizontal: 8, paddingBottom: 4, fontSize: 11, lineHeight: 16, letterSpacing: 1.1 },
  method: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 10 },
  cardIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  methodTitle: { fontSize: 14, lineHeight: 20 },
  methodDetail: { fontSize: 12, lineHeight: 16 },
  radio: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  renews: { textAlign: 'center', fontSize: 12, lineHeight: 16 }
})
