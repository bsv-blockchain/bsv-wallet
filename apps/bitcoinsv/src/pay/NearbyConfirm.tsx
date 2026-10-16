// The nearby payer's confirm, in this app's own style (Send Payment's confirm
// step, app/send.tsx). The core's NearbyFlow still owns the payment: it hands
// this the figures, the link's state and the actions (NearbyConfirm), and
// takes over again once Send is pressed.
import React, { useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Radio, User } from 'lucide-react-native'
import { useSpendableBalance, type NearbyConfirm as Confirm } from '@bsv/expo-wallet-toolbox/ui'
import { parseTokenAmount } from '@bsv/expo-wallet-toolbox/ui/tokenFormat'
import { font, usePalette } from '../theme'
import { TextInput } from '../ui/TextInput'
import { PageHeader } from '../ui/PageHeader'
import { GlassButton } from '../ui/GlassButton'
import { CoinMark } from '../ui/CoinMark'
import { RaisedAmount } from '../ui/RollingAmount'
import { BalancedText } from '../ui/BalancedText'
import { useFocusRing } from '../ui/focusRing'
import { AmountInput } from './AmountInput'
import { cleanAmount } from './amount'
import { bsvFigure } from '../activity/format'

const SATS_PER_BSV = 100_000_000

export function NearbyConfirm({ c }: { c: Confirm }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const spendable = useSpendableBalance()
  const descRing = useFocusRing(palette, '0 0 0 1px transparent')
  // an open request: the payer's own figure, as typed
  const [raw, setRaw] = useState('')

  const asset = c.asset
  const coin = asset ? ({ kind: 'token', ticker: asset.ticker } as const) : ({ kind: 'bsv' } as const)
  const figureOf = (units: number) => (asset ? (units / 10 ** asset.decimals).toString() : bsvFigure(units))
  const amountText = c.amount > 0 ? `${figureOf(c.amount)} ${asset?.ticker ?? 'BSV'}` : '—'
  const available = asset ? (c.holding ?? null) : spendable
  const availableText =
    available === null || available === undefined ? '…' : `${figureOf(available)} ${asset?.ticker ?? 'BSV'}`

  const type = (v: string) => {
    const next = cleanAmount(v, asset ? asset.decimals : 8)
    setRaw(next)
    if (asset) c.setAmount(parseTokenAmount(next, asset.decimals) ?? undefined)
    else {
      const n = parseFloat(next)
      c.setAmount(Number.isFinite(n) && n > 0 ? Math.round(n * SATS_PER_BSV) : undefined)
    }
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Pay nearby" onBack={c.cancel} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.confirm}>
        {/* who */}
        <View style={styles.party}>
          <View style={[styles.face, { backgroundColor: palette.secondary }]}>
            <User size={30} color={palette.mutedForeground} />
          </View>
          <Text numberOfLines={1} style={[font(600), styles.body15, { color: palette.foreground }]}>
            {c.recipient.name}
          </Text>
          {!!c.recipient.detail && (
            <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
              {c.recipient.detail}
            </Text>
          )}
        </View>

        {/* how much: theirs when they named it, otherwise yours to type */}
        <View style={styles.confirmAmount}>
          {c.fixedAmount !== undefined ? (
            <RaisedAmount
              figure={figureOf(c.fixedAmount)}
              unit={asset?.ticker}
              mark={asset ? undefined : m => <CoinMark coin={coin} size={m} />}
              size={48}
              color={palette.foreground}
            />
          ) : (
            <View style={styles.amountRow}>
              <AmountInput value={raw} onChange={type} size={48} accessibilityLabel={`Amount in ${asset?.ticker ?? 'BSV'}`} autoFocus />
              <CoinMark coin={coin} size={40} />
            </View>
          )}
          {!!c.tipText && (
            <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>{c.tipText}</Text>
          )}
          <Text style={[font(400), styles.small, styles.center, styles.paidFrom, { color: palette.mutedForeground }]}>
            Paid from your {asset?.ticker ?? 'BSV'} balance · {availableText} available
          </Text>
        </View>

        {/* what it's for: travels with the payment */}
        <Animated.View style={[styles.description, { backgroundColor: palette.card }, descRing.style]}>
          <TextInput
            value={c.note}
            onChangeText={c.setNote}
            {...descRing.handlers}
            placeholder="Description:"
            placeholderTextColor={palette.mutedForeground}
            accessibilityLabel="Description"
            maxLength={120}
            style={[font(400), styles.descriptionInput, { color: palette.foreground }]}
          />
        </Animated.View>

        <View style={styles.details}>
          {[
            { l: 'Wallet fee', v: 'Usually under a cent, in BSV' },
            { l: 'Total you pay', v: amountText },
            { l: 'Arrives', v: 'In seconds, phone to phone' }
          ].map(r => (
            <View key={r.l} style={styles.detailRow}>
              <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{r.l}</Text>
              <Text style={[font(500), styles.small, styles.detailValue, { color: palette.foreground }]}>{r.v}</Text>
            </View>
          ))}
        </View>

        {/* the link to their phone */}
        {c.presence && (
          <View style={styles.presence} accessibilityRole="text">
            <Radio size={16} color={c.presence.state === 'qr' ? palette.mutedForeground : palette.positive} />
            <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{c.presence.label}</Text>
          </View>
        )}

        {c.advisories.length > 0 && (
          <View style={[styles.advisory, { backgroundColor: palette.secondary }]}>
            {c.advisories.map(a => (
              <BalancedText key={a} style={[font(400), styles.small, { color: palette.foreground }]}>
                {a}
              </BalancedText>
            ))}
            {c.openSettings && (
              <Pressable onPress={c.openSettings} accessibilityRole="button" hitSlop={8}>
                <Text style={[font(600), styles.small, { color: palette.goldDeep }]}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <GlassButton size="lg" label="Send Payment" disabled={!c.canSend} onPress={c.send} />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  confirm: { gap: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  party: { alignItems: 'center', gap: 4, paddingTop: 8 },
  face: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  confirmAmount: { alignItems: 'center', gap: 4 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  paidFrom: { paddingTop: 4 },
  description: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, paddingLeft: 20, paddingRight: 8 },
  descriptionInput: { flex: 1, fontSize: 15, padding: 0 },
  details: { gap: 12, paddingHorizontal: 4 },
  detailRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  detailValue: { flexShrink: 1, textAlign: 'right' },
  presence: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  advisory: { gap: 6, borderRadius: 16, padding: 14 },
  footer: { gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  center: { textAlign: 'center', alignSelf: 'stretch' }
})
