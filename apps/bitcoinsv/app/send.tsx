// Pay someone (the prototype's app/(wallet)/send/page.tsx): who, how much,
// review, done. One recipient per payment (decision 8): a contact, an @handle
// from the handle registry (a bare @name is on this build's domain), a pay
// link, an identity key or a BSV address. The money moves on the shared
// core's rails (src/pay/useSendPayment.ts); the done screen says what the
// core says happened, never a scripted timeline (decision 15).
// With more than one wallet on this phone, the amount step's "From" row
// switches which pays, without leaving.
//
// ?to=<identityKey> starts at the amount for that person (a contact's Send),
// ?link=<pay link> for a scanned or pasted code, which can carry the amount.
import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowRight, Check, Clock, Download, Search } from 'lucide-react-native'
import { classifyRecipientInput, getHandleRegistryConfig, sounds, useWallet } from '@bsv/expo-wallet-toolbox'
import { useMandala, useSpendableBalance } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../src/ui/Toast'
import { Handle, useOwnDomains } from '../src/ui/Handle'
import { detailLabel, isHandle, matchesSearch } from '../src/contacts/handles'
import { cleanAmount } from '../src/pay/amount'
import { askForFeedbackSoon, countFeedbackEvent } from '../src/feedback/feedback'
import { DISPLAY_NAME_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { createHandleRegistryClient } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/client'
import type { RegistryProfile } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileCert'
import type { TokenAssetInfo } from '@bsv/expo-wallet-toolbox/core/mandala/runtime'
import { parseTokenAmount } from '@bsv/expo-wallet-toolbox/ui/tokenFormat'
import { font, usePalette } from '../src/theme'
import { BottomSheet } from '../src/ui/BottomSheet'
import { CoinMark } from '../src/ui/CoinMark'
import { BsvMark } from '../src/ui/BsvMark'
import { Coin } from '../src/ui/Coin'
import { Face } from '../src/ui/Face'
import { GlassButton } from '../src/ui/GlassButton'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { enter, useReducedMotion } from '../src/ui/motion'
import { RaisedAmount } from '../src/ui/RollingAmount'
import { useFocusRing } from '../src/ui/focusRing'
import { radii } from '../src/theme/tokens'
import { PayTabs } from '../src/pay/PayTabs'
import { AmountInput } from '../src/pay/AmountInput'
import { CoinButton } from '../src/pay/CoinButton'
import { FlipCard } from '../src/pay/FlipCard'
import { useSendPayment, type SendOutcome, type SendTarget } from '../src/pay/useSendPayment'
import { useRequests } from '../src/requests/useRequests'
import { notifyMoney } from '../src/notify/MoneyToast'
import { getPrefs } from '../src/state/prefs'
import { receiptFileName, receiptHtml } from '../src/activity/receipt'
import { sharePdf } from '../src/ui/sharePdf'
import type { ActivityItem } from '../src/activity/useActivity'
import { useWalletList } from '../src/home/useWalletList'
import { Avatar, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { BalancedText } from '../src/ui/BalancedText'
import { useContacts } from '../src/contacts/useContacts'
import { registryQuery } from '../src/contacts/registryQuery'
import { bsvFigure } from '../src/activity/format'

const SATS_PER_BSV = 100_000_000
/**
 * The core's send-max amount: the wallet sends whatever the balance can fund
 * once the network fee is taken, and the rails read back what was paid
 * (core/pay/rails/address.ts, handle.ts).
 */
const SEND_ALL_SATS = 2099999999999999

interface Recipient {
  target: SendTarget
  /** what to call them */
  name: string
  /** the line under the name: their handle, or a shortened key or address */
  detail: string
  /** an amount the pay link asked for */
  sats?: number
  assetId?: string
  amount?: number
  /** what the payee's link says it's for */
  note?: string
}

const short = (s: string) => (s.length > 17 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s)

export default function Send() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  // `request`: paying someone's payment request (src/requests), marked paid once
  // sent; `note`: what it was for, the payment's note to start with
  // `handle`: a website's /@handle link, the search filled in
  const params = useLocalSearchParams<{ to?: string; link?: string; request?: string; note?: string; handle?: string }>()
  const contacts = useContacts()
  // handles written as handles are ("@rosa"): this wallet's own domains
  const own = useOwnDomains()
  const mandala = useMandala()
  const spendable = useSpendableBalance()
  const payment = useSendPayment()
  const requests = useRequests()

  const [step, setStep] = useState<'who' | 'amount' | 'confirm' | 'done'>(params.to || params.link ? 'amount' : 'who')
  const [recipient, setRecipient] = useState<Recipient | null>(null)
  const [asset, setAsset] = useState<TokenAssetInfo | null>(null)
  const [raw, setRaw] = useState('')
  // "Available" tapped: everything, less the network fee (BSV), or the whole token balance
  const [sendAll, setSendAll] = useState(false)
  const [note, setNote] = useState(params.note ?? '')
  const [picking, setPicking] = useState(false)
  // which of this phone's wallets pays (the prototype's "From" row)
  const wallets = useWalletList()
  const payingFrom = wallets.find(w => w.active)
  const [fromOpen, setFromOpen] = useState(false)
  const { switchProfile, storage } = useWallet()
  // your display name, for the review's "from" side
  const [myName, setMyName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    storage
      ?.getKeyValue(DISPLAY_NAME_KV_KEY)
      .then(v => alive && setMyName(v || null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [storage])
  const still = useReducedMotion()
  const descRing = useFocusRing(palette, `0 0 0 1px ${palette.border}`)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<SendOutcome | null>(null)

  // a person or a link handed in: straight to the amount
  // a contact handed in before the contacts had loaded: their name once they have
  useEffect(() => {
    if (!params.to || !recipient || recipient.target.kind !== 'person') return
    const c = contacts.byKey.get(params.to.toLowerCase())
    if (c && recipient.name !== c.name) setRecipient({ ...recipient, target: { ...recipient.target, name: c.name }, name: c.name, detail: c.cachedHandle ?? recipient.detail })
  }, [params.to, contacts.byKey, recipient])
  useEffect(() => {
    if (params.to && !recipient) {
      const c = contacts.byKey.get(params.to.toLowerCase())
      setRecipient({
        target: { kind: 'person', identityKey: params.to, name: c?.name },
        name: c?.name ?? short(params.to),
        detail: c?.cachedHandle ?? `Identity key · ${short(params.to)}`
      })
    }
  }, [params.to, contacts.byKey, recipient])
  useEffect(() => {
    if (!params.link || recipient) return
    const r = fromInput(params.link, contacts.byKey)
    if (r) {
      setRecipient(r)
      if (r.sats) setRaw(bsvFigure(r.sats))
      // what the payee's link says it's for starts the payment's note
      if (r.note && !params.note) setNote(r.note)
    } else setStep('who')
  }, [params.link, contacts.byKey, recipient])
  // a link that asks for a stablecoin picks it, if you hold it
  useEffect(() => {
    if (!recipient?.assetId) return
    const a = mandala.assets.find(x => x.assetId.toLowerCase() === recipient.assetId?.toLowerCase())
    if (a) {
      setAsset(a)
      if (recipient.amount) setRaw(String(recipient.amount / 10 ** a.decimals))
    }
  }, [recipient, mandala.assets])

  const units = useMemo(() => {
    if (asset) return parseTokenAmount(raw, asset.decimals) ?? 0
    const n = parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? Math.round(n * SATS_PER_BSV) : 0
  }, [raw, asset])
  const heldToken = asset ? (mandala.balances ?? []).find(b => b.asset.assetId === asset.assetId) : undefined
  const available = asset ? (heldToken ? Number(heldToken.baseUnits ?? 0) : null) : spendable
  const allBsv = sendAll && !asset
  const overdrawn = !allBsv && available !== null && units > available
  const amountOk = (allBsv ? (available ?? 0) > 0 : units > 0) && !overdrawn
  const amountText = asset ? `${raw || '0'} ${asset.ticker}` : `${bsvFigure(units)} BSV`
  const availableText = available === null ? '…' : asset ? `${(available / 10 ** asset.decimals).toString()} ${asset.ticker}` : `${bsvFigure(available)} BSV`
  const first = recipient?.name.split(' ')[0] ?? ''

  const submit = async () => {
    if (!recipient || !amountOk || busy) return
    setBusy(true)
    const r = await payment.send({ target: recipient.target, units: allBsv ? SEND_ALL_SATS : units, asset, note })
    setBusy(false)
    if (!r) return
    setOutcome(r)
    if (r.kind === 'sent') {
      setStep('done')
      // toward "Enjoying Bitcoin SV Wallet?" (asked once this screen is left)
      countFeedbackEvent('payment')
      // theirs, paid: only when it went to them, for at least what they asked
      const asked = params.request ? requests.requests.find(q => q.id === params.request) : undefined
      if (
        asked &&
        recipient.target.kind === 'person' &&
        recipient.target.identityKey.toLowerCase() === asked.counterparty &&
        (asset ? asset.assetId.toLowerCase() === asked.asset?.assetId : !asked.asset) &&
        (allBsv || units >= asked.units)
      )
        void requests.paid(asked.id)
      // the prototype's send-off: its tone (the Sounds switch), and the money
      // toast going out (Payment alerts: "when money arrives or leaves")
      sounds.paymentSend()
      if (getPrefs().paymentAlerts) notifyMoney({
        title: `Sent to ${recipient.name.startsWith('@') ? recipient.name : recipient.name.split(' ')[0]}`,
        description: note.trim() ? `“${note.trim()}”` : r.statusNote || undefined,
        amount: `−${r.amountText}`,
        counterparty: recipient.target.kind === 'person' ? { kind: 'identityKey', value: recipient.target.identityKey } : null
      })
    }
  }

  // what was just paid, as a receipt: who, how much, what for, when
  const receiptNow = async () => {
    if (!recipient || outcome?.kind !== 'sent') return
    const at = new Date().toISOString()
    const row = {
      id: at,
      incoming: false,
      ...(asset ? { token: { figure: raw || '0', unit: asset.ticker, assetId: asset.assetId } } : { sats: -(allBsv ? 0 : units) }),
      title: recipient.name,
      note: note.trim() || undefined,
      counterparty: null,
      status: { tone: 'settled' },
      statusText: 'Sent',
      pending: false,
      createdAt: at,
      rawStatus: 'sending',
      labels: []
    } as unknown as ActivityItem
    try {
      // the amount sent, as the core reported it, when it's "everything"
      const html = receiptHtml(allBsv ? { ...row, sats: undefined, token: { figure: outcome.amountText.replace(/ BSV$/, ''), unit: 'BSV', assetId: '' } } : row, { who: recipient.name })
      await sharePdf(html, receiptFileName(row))
    } catch {
      showToast('The receipt couldn’t be made. Try again.', { type: 'error' })
    }
  }

  const reset = () => {
    setStep('who')
    setRecipient(null)
    setRaw('')
    setSendAll(false)
    setNote('')
    setOutcome(null)
    setAsset(null)
  }

  // ── done: what the core says happened ──
  if (step === 'done' && recipient && outcome?.kind === 'sent') {
    // the core's amount text, "0.0001 BSV" or "12.50 USDC": figure and unit
    const at = outcome.amountText.lastIndexOf(' ')
    const sentFigure = at > 0 ? outcome.amountText.slice(0, at) : outcome.amountText
    const sentUnit = at > 0 ? outcome.amountText.slice(at + 1) : undefined
    const sentCoin = asset ? ({ kind: 'token', ticker: asset.ticker } as const) : ({ kind: 'bsv' } as const)
    // what the core says: theirs (a tick, and the card turns to the coin), or
    // still on its way (a clock: this screen doesn't follow it; Activity does)
    const settled = outcome.settled
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Payment" onBack={() => router.replace('/')} />
        </View>
        <ScrollView contentContainerStyle={[styles.doneBody, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.done}>
            {/* a green check once it's theirs; a clock while it's still settling */}
            <View>
              <RecipientFace recipient={recipient} size={64} />
              <Animated.View
                style={[
                  styles.doneBadge,
                  {
                    backgroundColor: settled ? palette.positive : palette.ink,
                    boxShadow: `0 0 0 2px ${palette.background}`,
                    transitionProperty: 'backgroundColor',
                    transitionDuration: still ? 0 : 300
                  }
                ]}
              >
                {settled ? (
                  <Animated.View style={still ? null : enter({ scale: 0.5, opacity: 1, duration: 300 })}>
                    <Check size={14} color="#ffffff" strokeWidth={3.2} />
                  </Animated.View>
                ) : (
                  <Clock size={14} color="#ffffff" strokeWidth={2.8} />
                )}
              </Animated.View>
            </View>
            <View style={styles.doneAmount}>
              <RaisedAmount figure={sentFigure} unit={asset ? sentUnit : undefined} mark={asset ? undefined : m => <BsvMark size={m} />} size={36} color={palette.foreground} />
            </View>
            <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>to {recipient.name}</Text>
          </View>
          {/* turns over to the coin of what was sent, two seconds after */}
          <FlipCard
            done={settled}
            back={
              <>
                <Coin size={84} icon={asset ? <CoinMark coin={sentCoin} size={64} /> : undefined} />
                <View style={styles.backText}>
                  <RaisedAmount figure={sentFigure} unit={asset ? sentUnit : undefined} mark={asset ? undefined : m => <BsvMark size={m} ink />} sign="−" size={24} color={palette.foreground} />
                  <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground, paddingTop: 2 }]}>Sent to {recipient.name}</Text>
                </View>
              </>
            }
          >
            {/* what the core says happened */}
            <View style={styles.doneNote}>
              <BalancedText style={[font(500), styles.small, styles.center, { color: palette.foreground }]}>
                {outcome.statusNote || `Sent to ${recipient.name}.`}
              </BalancedText>
              {!!note.trim() && (
                <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>“{note.trim()}”</Text>
              )}
            </View>
          </FlipCard>
          <View style={styles.doneButtons}>
            {/* the feedback card, if it's time, a moment after this screen goes */}
            <GlassButton
              size="lg"
              label="Done"
              onPress={() => {
                router.replace('/')
                askForFeedbackSoon('payment')
              }}
            />
            <GlassButton
              size="lg"
              variant="outline"
              label="Pay again"
              onPress={() => {
                reset()
                askForFeedbackSoon('payment')
              }}
            />
            {/* a receipt now (its transaction id is on the payment's own page, once it's in Activity) */}
            <GlassButton
              size="lg"
              variant="outline"
              label="Download receipt"
              icon={<Download size={16} color={palette.foreground} />}
              onPress={() => void receiptNow()}
            />
          </View>
        </ScrollView>
      </View>
    )
  }

  // ── review ──
  if (step === 'confirm' && recipient) {
    const coin = asset ? ({ kind: 'token', ticker: asset.ticker } as const) : ({ kind: 'bsv' } as const)
    const figure = asset ? raw || '0' : bsvFigure(units)
    return (
      <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Send Payment" onBack={() => setStep('amount')} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.confirm}>
          {/* from → to */}
          <View style={styles.fromTo}>
            <View style={styles.party}>
              {payingFrom ? (
                <Avatar
                  bg={(payingFrom.look?.avatarBg as AvatarBg) ?? 'mint'}
                  portrait={(payingFrom.look?.avatarPortrait as Portrait) ?? 'dragon'}
                  uri={payingFrom.look?.avatarUri ?? undefined}
                  size={72}
                />
              ) : (
                <View style={styles.face72} />
              )}
              <Text numberOfLines={1} style={[font(600), styles.small, { color: palette.foreground }]}>
                {myName ?? payingFrom?.name ?? 'You'}
              </Text>
              {!!payingFrom?.handle && (
                <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                  {payingFrom.name}
                </Text>
              )}
            </View>
            <ArrowRight size={28} color={palette.mutedForeground} strokeWidth={1.8} style={styles.arrow} />
            <View style={styles.party}>
              <RecipientFace recipient={recipient} size={72} />
              <Text numberOfLines={1} style={[font(600), styles.small, { color: palette.foreground }]}>
                {recipient.name}
              </Text>
              <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                {detailLabel(recipient.detail, own)}
              </Text>
              {/* what lands with them */}
              <View style={styles.lands}>
                <SmallRaised figure={allBsv ? `~${figure}` : figure} unit={asset?.ticker} color={palette.mutedForeground} />
                {!asset && <BsvMark size={14} ink />}
              </View>
            </View>
          </View>

          {/* amount */}
          <View style={styles.confirmAmount}>
            {allBsv ? (
              <Text style={[font(800), styles.everything, { color: palette.foreground }]}>Everything</Text>
            ) : (
              <RaisedAmount
                figure={figure}
                unit={asset?.ticker}
                mark={asset ? undefined : m => <CoinMark coin={coin} size={m} />}
                size={48}
                color={palette.foreground}
              />
            )}
            {allBsv && (
              <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
                About {amountText}, less the network fee
              </BalancedText>
            )}
            <Text style={[font(400), styles.small, styles.center, styles.paidFrom, { color: palette.mutedForeground }]}>
              Paid from your {asset?.ticker ?? 'BSV'} balance
            </Text>
          </View>

          {/* description */}
          <Animated.View style={[styles.description, { backgroundColor: palette.card }, descRing.style]}>
            <TextInput
              value={note}
              onChangeText={setNote}
              {...descRing.handlers}
              placeholder="Description:"
              placeholderTextColor={palette.mutedForeground}
              accessibilityLabel="Description"
              maxLength={120}
              style={[font(400), styles.descriptionInput, { color: palette.foreground }]}
            />
          </Animated.View>

          {/* what it costs and when it lands */}
          <View style={styles.details}>
            {[
              { l: 'Wallet fee', v: 'Usually under a cent, in BSV' },
              { l: 'Total you pay', v: allBsv ? 'Your whole balance' : amountText },
              { l: 'Arrives', v: recipient.target.kind === 'person' ? 'In seconds' : 'Once the network has it' }
            ].map(r => (
              <View key={r.l} style={styles.detailRow}>
                <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{r.l}</Text>
                <Text style={[font(500), styles.small, styles.detailValue, { color: palette.foreground }]}>{r.v}</Text>
              </View>
            ))}
          </View>
          {outcome?.kind === 'failed' && (
            <View style={[styles.failure, { backgroundColor: palette.destructive + '14' }]}>
              <Text style={[font(600), styles.small, { color: palette.destructive }]}>
                {outcome.refused ? 'Not sent' : 'Not sent yet'}
              </Text>
              <Text style={[font(400), styles.small, { color: palette.foreground }]}>{outcome.message}</Text>
            </View>
          )}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <GlassButton size="lg" label="Send Payment" loading={busy} disabled={!amountOk} onPress={() => void submit()} />
        </View>
      </KeyboardAvoidingView>
    )
  }

  // ── how much ──
  if (step === 'amount' && recipient) {
    const coin = asset ? ({ kind: 'token', ticker: asset.ticker } as const) : ({ kind: 'bsv' } as const)
    return (
      // the button stays above the keyboard (Android's edge-to-edge screens aren't resized for it)
      <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title={`Pay ${first}`} onBack={params.to ? undefined : () => setStep('who')} />
        </View>
        <View style={styles.amountArea}>
          <View style={styles.amountRow}>
            {/* number first, then the coin's own mark: tap it to change */}
            <AmountInput
              value={raw}
              onChange={v => {
                setSendAll(false)
                setRaw(cleanAmount(v, asset ? asset.decimals : 8))
              }}
              accessibilityLabel={`Amount in ${asset?.ticker ?? 'BSV'}`}
              invalid={overdrawn}
              autoFocus
            />
            <CoinButton
              coin={coin}
              size={56}
              badge={mandala.assets.length > 0}
              onPress={() => setPicking(true)}
              accessibilityLabel={`Currency: ${asset?.ticker ?? 'BSV'}${mandala.assets.length ? '. Change currency' : ''}`}
            />
          </View>
          {/* tap to send it all */}
          <Pressable
            onPress={() => {
              if (!available) return
              if (asset) setRaw(String(available / 10 ** asset.decimals))
              else {
                setRaw(bsvFigure(available))
                setSendAll(true)
              }
            }}
            disabled={!available}
            accessibilityRole="button"
            accessibilityLabel={`Available: ${availableText}. Send it all`}
            hitSlop={8}
          >
            <Text style={[font(overdrawn ? 500 : 400), styles.available, { color: overdrawn ? palette.destructive : palette.mutedForeground }]}>
              Available: {availableText}
            </Text>
          </Pressable>
          {mandala.assets.length > 0 && (
            <Pressable onPress={() => setPicking(true)} accessibilityRole="button" hitSlop={8} style={styles.chooseCurrency}>
              <Text style={[font(600), styles.chooseText, { color: palette.goldDeep }]}>Choose currency</Text>
            </Pressable>
          )}
        </View>
        <View style={[styles.footer, styles.amountFooter, { paddingBottom: insets.bottom + 16 }]}>
          {/* which wallet pays, with more than one on this phone */}
          {/* not while paying a request: it was asked of this wallet */}
          {wallets.length > 1 && payingFrom && !params.request && (
            <Pressable
              onPress={() => setFromOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`From ${payingFrom.name}. Change wallet`}
              style={({ pressed }) => [
                styles.from,
                { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` },
                pressed && { backgroundColor: palette.secondary + '99' }
              ]}
            >
              <Text numberOfLines={1} style={[font(400), styles.fromText, { color: palette.mutedForeground }]}>
                From: <Text style={[font(500), { color: palette.foreground }]}>{myName ?? payingFrom.name}</Text>
              </Text>
              <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{availableText}</Text>
              <Avatar
                bg={(payingFrom.look?.avatarBg as AvatarBg) ?? 'mint'}
                portrait={(payingFrom.look?.avatarPortrait as Portrait) ?? 'dragon'}
                uri={payingFrom.look?.avatarUri ?? undefined}
                size={40}
              />
            </Pressable>
          )}
          <GlassButton
            size="lg"
            label={!units ? 'Enter an amount' : overdrawn ? 'Not enough balance' : 'Review payment'}
            disabled={!amountOk}
            onPress={() => {
              setOutcome(null)
              setStep('confirm')
            }}
          />
        </View>
        <BottomSheet open={fromOpen} onOpenChange={setFromOpen} title="Pay from" description="The wallet this payment comes out of.">
          {wallets.map(w => (
            <Pressable
              key={w.index}
              onPress={async () => {
                setFromOpen(false)
                if (w.active) return
                setSendAll(false)
                await switchProfile(w.index)
                showToast(`Paying from ${w.name}`, { type: 'success' })
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: w.active }}
              style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary }]}
            >
              <Avatar
                bg={(w.look?.avatarBg as AvatarBg) ?? 'mint'}
                portrait={(w.look?.avatarPortrait as Portrait) ?? 'dragon'}
                uri={w.look?.avatarUri ?? undefined}
                size={40}
              />
              <Text style={[font(600), styles.body15, styles.flex, { color: palette.foreground }]}>{w.name}</Text>
              {w.active && <Check size={18} color={palette.foreground} />}
            </Pressable>
          ))}
        </BottomSheet>
        <BottomSheet open={picking} onOpenChange={setPicking} title="Choose currency">
          {[null, ...mandala.assets].map(a => {
            const on = (a?.assetId ?? null) === (asset?.assetId ?? null)
            return (
              <Pressable
                key={a?.assetId ?? 'bsv'}
                onPress={() => {
                  setAsset(a)
                  setRaw('')
                  setSendAll(false)
                  setPicking(false)
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary }]}
              >
                <CoinMark coin={a ? { kind: 'token', ticker: a.ticker } : { kind: 'bsv' }} size={40} />
                <Text style={[font(600), styles.body15, styles.flex, { color: palette.foreground }]}>{a ? a.label : 'BitcoinSV'}</Text>
                {on && <Check size={18} color={palette.foreground} />}
              </Pressable>
            )
          })}
        </BottomSheet>
      </KeyboardAvoidingView>
    )
  }

  // ── who ──
  return (
    <WhoStep
      initialQuery={params.handle ?? ''}
      onPick={r => {
        setRecipient(r)
        setAsset(null)
        setRaw(r.sats ? bsvFigure(r.sats) : '')
        setStep('amount')
      }}
    />
  )
}

/** A recipient from something typed, pasted or scanned: a pay link, an address or a key. */
function fromInput(text: string, byKey: Map<string, { name: string; cachedHandle?: string }>): Recipient | null {
  const r = classifyRecipientInput(text)
  if (r.kind === 'address') return { target: { kind: 'address', address: r.address }, name: short(r.address), detail: `Address · ${short(r.address)}` }
  if (r.kind === 'handle') {
    const c = byKey.get(r.identityKey.toLowerCase())
    return {
      target: { kind: 'person', identityKey: r.identityKey, messageBoxUrl: r.messageBoxUrl, name: c?.name },
      name: c?.name ?? short(r.identityKey),
      detail: c?.cachedHandle ?? `Identity key · ${short(r.identityKey)}`,
      sats: r.sats,
      assetId: r.asset,
      amount: r.amount,
      note: r.note
    }
  }
  return null
}

function RecipientFace({ recipient, size }: { recipient: Recipient; size: number }) {
  const t = recipient.target
  return <Face counterparty={t.kind === 'person' ? { kind: 'identityKey', value: t.identityKey } : { kind: 'address', value: t.address }} size={size} />
}

/** An amount at text size, raised as the prototype's Money (the decimals small and top-aligned). */
function SmallRaised({ figure, unit, color, size = 14 }: { figure: string; unit?: string; color: string; size?: number }) {
  const m = figure.match(/^(.*?)(\.\d+)$/)
  return (
    <View style={styles.raisedRow}>
      <Text style={[font(400), { color, fontSize: size, lineHeight: size * 1.4, fontVariant: ['tabular-nums'] }]}>{m ? m[1] : figure}</Text>
      {!!m && <Text style={[font(400), { color, fontSize: size * 0.55, lineHeight: size * 0.7, marginTop: size * 0.27, fontVariant: ['tabular-nums'] }]}>{m[2]}</Text>}
      {!!unit && <Text style={[font(400), { color, fontSize: size, lineHeight: size * 1.4 }]}> {unit}</Text>}
    </View>
  )
}

/** Who to pay: your favourites, then what you type, matched against contacts and the handle registry. */
function WhoStep({ onPick, initialQuery = '' }: { onPick: (r: Recipient) => void; initialQuery?: string }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const contacts = useContacts()
  const { selectedNetwork } = useWallet()
  const registry = getHandleRegistryConfig(selectedNetwork)
  const client = useMemo(
    () => (registry?.domain && registry?.url ? createHandleRegistryClient({ pinned: { domain: registry.domain, url: registry.url } }) : null),
    [registry?.domain, registry?.url]
  )
  const [query, setQuery] = useState(initialQuery)
  const [found, setFound] = useState<RegistryProfile[]>([])
  const [searching, setSearching] = useState(false)
  const ring = useFocusRing(palette)

  const direct = useMemo(() => (query.trim() ? fromInput(query.trim(), contacts.byKey) : null), [query, contacts.byKey])
  const q = query.trim().toLowerCase()
  const own = useOwnDomains()
  // by name, or handle in any form, with or without its @ (src/contacts/handles.ts)
  const mine = (contacts.list ?? []).filter(c => !q || matchesSearch({ name: c.name, handle: c.cachedHandle }, q))
  const shownContacts = q ? mine : mine.filter(c => c.favourite).concat(mine.filter(c => !c.favourite)).slice(0, 8)

  useEffect(() => {
    const rq = direct ? null : registryQuery(query, registry?.domain)
    if (!rq || !client) {
      setFound([])
      return
    }
    let live = true
    setSearching(true)
    const t = setTimeout(() => {
      client
        .search(rq)
        .then(r => live && setFound(r.filter(p => !contacts.byKey.has(p.identityKey.toLowerCase()))))
        .catch(() => live && setFound([]))
        .finally(() => live && setSearching(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, client, registry?.domain, direct, contacts.byKey])

  const row = (key: string, face: React.ReactNode, title: string, sub: string, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}>
      {face}
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
          {title}
        </Text>
        {/* a handle as handles are written ("@rosa", or with its wallet's mark) */}
        {isHandle(sub) ? (
          <Handle handle={sub} style={[font(400), styles.xs, { color: palette.mutedForeground }]} />
        ) : (
          <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
            {sub}
          </Text>
        )}
      </View>
    </Pressable>
  )

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={[styles.pad, styles.whoHead]}>
        <PageHeader
          title="Pay"
          action={
            <ViewInfo about="Pay" text="Pick someone, tap in an amount, and off it goes. Money lands in seconds and the fee is less than a cent." />
          }
        />
        <PayTabs active="/send" />
        <Animated.View style={[styles.search, { backgroundColor: palette.card }, ring.style]}>
          <Search size={16} color={palette.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            {...ring.handlers}
            placeholder="Name, @handle, address or identity key"
            placeholderTextColor={palette.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Who to pay"
            style={[font(400), styles.searchInput, { color: palette.foreground }]}
          />
          {searching && <ActivityIndicator size="small" color={palette.mutedForeground} />}
        </Animated.View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}>
        {direct &&
          row(
            'direct',
            <RecipientFace recipient={direct} size={40} />,
            direct.name,
            direct.target.kind === 'address' ? 'Pay this address' : direct.detail,
            () => onPick(direct)
          )}
        {shownContacts.length > 0 && <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>{q ? 'CONTACTS' : 'YOUR PEOPLE'}</Text>}
        {shownContacts.map(c =>
          row(
            c.identityKey,
            <Face counterparty={{ kind: 'identityKey', value: c.identityKey }} avatarUrl={c.cachedAvatarUrl} size={40} />,
            c.name,
            c.cachedHandle ?? `Identity key · ${short(c.identityKey)}`,
            () => onPick({ target: { kind: 'person', identityKey: c.identityKey, name: c.name }, name: c.name, detail: c.cachedHandle ?? short(c.identityKey) })
          )
        )}
        {found.length > 0 && <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>ON BITCOIN SV WALLET</Text>}
        {found.map(p =>
          row(
            p.identityKey + p.paymail,
            <Face counterparty={{ kind: 'identityKey', value: p.identityKey }} size={40} />,
            p.displayName ?? p.handle,
            p.paymail,
            () =>
              onPick({
                target: { kind: 'person', identityKey: p.identityKey, name: p.displayName ?? p.handle },
                name: p.displayName ?? p.handle,
                detail: p.paymail
              })
          )
        )}
        {!direct && !found.length && !searching && q.length > 0 && !mine.length && (
          <Text style={[font(400), styles.small, styles.center, styles.none, { color: palette.mutedForeground }]}>No one by that name or handle.</Text>
        )}
        {!q && !(contacts.list ?? []).length && (
          <Animated.View style={[styles.hint, enter({ opacity: 0, duration: 300 })]}>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              Type someone’s @handle, or paste their pay link or address.
            </BalancedText>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  flex: { flex: 1, minWidth: 0 },
  whoHead: { gap: 16, paddingBottom: 8 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  // the prototype's Input at h-12 rounded-2xl, text-base
  search: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii['2xl'], paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 16, padding: 0 },
  list: { paddingHorizontal: 8 },
  eyebrow: { paddingTop: 12, paddingBottom: 6, paddingLeft: 12, fontSize: 11, lineHeight: 16, letterSpacing: 1.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  none: { paddingVertical: 24 },
  hint: { paddingHorizontal: 24, paddingVertical: 32 },
  amountArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 24 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  available: { fontSize: 16, lineHeight: 24, alignSelf: 'stretch', textAlign: 'center' },
  chooseCurrency: { paddingTop: 12 },
  chooseText: { fontSize: 16, lineHeight: 24, paddingVertical: 4 },
  // "From: name — balance — avatar" (h-14 rounded-full bg-card pl-5 pr-2 ring-1)
  from: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 999, paddingLeft: 20, paddingRight: 8 },
  fromText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, paddingHorizontal: 8, paddingVertical: 10 },
  footer: { gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  amountFooter: { gap: 12 },
  confirm: { gap: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  fromTo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  party: { flex: 1, minWidth: 0, alignItems: 'center', gap: 6 },
  face72: { width: 72, height: 72 },
  arrow: { marginTop: 24 },
  lands: { flexDirection: 'row', alignItems: 'center', gap: 4, marginVertical: 4 },
  raisedRow: { flexDirection: 'row', alignItems: 'flex-start' },
  confirmAmount: { alignItems: 'center', gap: 4 },
  everything: { fontSize: 48, lineHeight: 56, letterSpacing: -1.2, alignSelf: 'stretch', textAlign: 'center' },
  paidFrom: { paddingTop: 4 },
  // h-14 rounded-full bg-card pl-5 pr-2 ring-1 ring-border
  description: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, paddingLeft: 20, paddingRight: 8 },
  descriptionInput: { flex: 1, fontSize: 15, padding: 0 },
  details: { gap: 12, paddingHorizontal: 4 },
  detailRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  detailValue: { flexShrink: 1, textAlign: 'right' },
  failure: { alignSelf: 'stretch', gap: 2, borderRadius: 16, padding: 14 },
  doneBody: { gap: 16, paddingHorizontal: 16 },
  done: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  doneBadge: { position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  doneAmount: { paddingTop: 8 },
  doneNote: { gap: 4 },
  backText: { alignItems: 'center' },
  doneButtons: { gap: 8, paddingTop: 8 }
})
