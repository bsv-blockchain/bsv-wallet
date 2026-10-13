// A contact (the prototype's app/(wallet)/contacts/[id]/page.tsx): who they
// are, Send and Request, what you've sent and received, and your payments
// with them, day by day. Request asks them for an amount in their own wallet
// (src/requests), or shares the pay link when there's no message box.
import React, { useMemo, useState } from 'react'
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../../src/ui/TextInput'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, HandCoins, Star } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { NO_MESSAGE_BOX, peerPayLinkFor, useWallet } from '@bsv/expo-wallet-toolbox'
import { useMessageBoxConfig } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../../src/ui/Toast'
import { Handle } from '../../src/ui/Handle'
import { Pressable } from 'react-native'
import { font, radii, usePalette } from '../../src/theme'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { Face } from '../../src/ui/Face'
import { GlassButton } from '../../src/ui/GlassButton'
import { PageHeader } from '../../src/ui/PageHeader'
import { BalancedText } from '../../src/ui/BalancedText'
import { BsvMark } from '../../src/ui/BsvMark'
import { RaisedAmount } from '../../src/ui/RollingAmount'
import { TxRow } from '../../src/activity/TxRow'
import { bsvFigure, groupByDay } from '../../src/activity/format'
import { useActivity } from '../../src/activity/useActivity'
import { useContacts } from '../../src/contacts/useContacts'
import { useRequests } from '../../src/requests/useRequests'

const SATS_PER_BSV = 100_000_000

export default function ContactScreen() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { key } = useLocalSearchParams<{ key: string }>()
  const contacts = useContacts()
  const { items } = useActivity()
  const [requesting, setRequesting] = useState(false)
  const contact = key ? contacts.byKey.get(key.toLowerCase()) : undefined

  const shared = useMemo(
    () => (items ?? []).filter(t => t.counterparty?.kind === 'identityKey' && t.counterparty.value.toLowerCase() === key?.toLowerCase()),
    [items, key]
  )
  const sent = shared.filter(t => !t.incoming && t.sats).reduce((s, t) => s + Math.abs(t.sats ?? 0), 0)
  const received = shared.filter(t => t.incoming && t.sats).reduce((s, t) => s + Math.abs(t.sats ?? 0), 0)
  const groups = groupByDay(shared)

  if (!contact) {
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Contact" />
          {contacts.list !== null && (
            <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>This contact isn’t in your contacts any more.</Text>
          )}
        </View>
      </View>
    )
  }

  const toggleFavourite = async () => {
    const next = !contact.favourite
    await contacts.setFavourite(contact.identityKey, next)
    showToast(next ? `${contact.name.split(' ')[0]} added to favourites` : `${contact.name.split(' ')[0]} removed from favourites`, { type: 'success' })
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader
          title="Contact"
          action={
            <Pressable
              onPress={() => void toggleFavourite()}
              accessibilityRole="button"
              accessibilityLabel={contact.favourite ? `Remove ${contact.name} from favourites` : `Add ${contact.name} to favourites`}
              accessibilityState={{ selected: contact.favourite }}
              style={styles.round}
            >
              <Star size={18} color={contact.favourite ? palette.gold : palette.mutedForeground} fill={contact.favourite ? palette.gold : 'none'} />
            </Pressable>
          }
        />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.who}>
          <Face counterparty={{ kind: 'identityKey', value: contact.identityKey }} avatarUrl={contact.cachedAvatarUrl} size={72} />
          <Text style={[font(700), styles.name, { color: palette.foreground }]}>{contact.name}</Text>
          {contact.cachedHandle ? (
            <Handle handle={contact.cachedHandle} qualified style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]} />
          ) : (
            <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              {`${contact.identityKey.slice(0, 10)}…${contact.identityKey.slice(-10)}`}
            </Text>
          )}
        </View>
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <GlassButton
              label="Send"
              icon={<ArrowUpRight size={18} color={palette.goldForeground} />}
              onPress={() => router.push({ pathname: '/send', params: { to: contact.identityKey } })}
            />
          </View>
          <View style={styles.flex}>
            <GlassButton variant="outline" label="Request" icon={<HandCoins size={18} color={palette.foreground} />} onPress={() => setRequesting(true)} />
          </View>
        </View>
        <View style={styles.totals}>
          {[
            { l: 'You sent', v: sent, positive: false },
            { l: 'You received', v: received, positive: true }
          ].map(t => (
            <View key={t.l} style={[styles.total, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
              <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{t.l}</Text>
              <Text style={[font(600), styles.totalValue, { color: t.positive && t.v ? palette.positive : palette.foreground }]}>{bsvFigure(t.v)} BSV</Text>
            </View>
          ))}
        </View>
        {groups.length === 0 ? (
          <Text style={[font(400), styles.small, styles.center, styles.none, { color: palette.mutedForeground }]}>No payments between you yet.</Text>
        ) : (
          groups.map(g => (
            <View key={g.label}>
              <Text style={[font(600), styles.day, { color: palette.mutedForeground }]}>{g.label.toUpperCase()}</Text>
              <View style={[styles.card, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
                {g.items.map(tx => (
                  <TxRow key={tx.id} tx={tx} />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
      <RequestSheet
        open={requesting}
        onOpenChange={setRequesting}
        identityKey={contact.identityKey}
        name={contact.name}
        avatarUrl={contact.cachedAvatarUrl}
      />
    </View>
  )
}

/**
 * Request from a contact: an amount and what it's for. It reaches their
 * Bitcoin SV Wallet and waits in both activities until it's paid
 * (src/requests); with no message box, the pay link is shared instead
 * (decision 9). Once sent, the sheet says so (the prototype's RequestDialog:
 * their face, the amount, Done).
 */
function RequestSheet({
  open,
  onOpenChange,
  identityKey,
  name,
  avatarUrl
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  identityKey: string
  name: string
  avatarUrl?: string
}) {
  const palette = usePalette()
  const { t } = useTranslation()
  const { managers, adminOriginator } = useWallet()
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const requests = useRequests()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // the request that just went, in sats: the sheet shows it sent
  const [sent, setSent] = useState(0)
  // a fresh form every time the sheet reopens (set while rendering, as React suggests)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setSent(0)
      setAmount('')
      setNote('')
    }
  }
  const first = name.split(' ')[0]
  const value = parseFloat(amount)
  const sats = Number.isFinite(value) && value > 0 ? Math.round(value * SATS_PER_BSV) : 0
  const request = async () => {
    if (!sats || busy) return
    setBusy(true)
    try {
      const r = await managers.permissionsManager?.getPublicKey({ identityKey: true }, adminOriginator)
      if (!r) return
      const box = messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX ? messageBoxUrl : undefined
      const link = peerPayLinkFor(r.publicKey, sats, box)
      if (requests.ready) {
        await requests.ask({ to: identityKey, name, units: sats, note, link })
        setSent(sats)
        return
      }
      await Share.share({ message: `Please pay me ${bsvFigure(sats)} BSV with Bitcoin SV Wallet: ${link}` }).catch(() => {})
      onOpenChange(false)
      setAmount('')
      setNote('')
    } catch {
      showToast('The request couldn’t be sent. Try again in a moment.', { type: 'error' })
    } finally {
      setBusy(false)
    }
  }
  if (sent)
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title="Request sent">
        {/* flex-col items-center gap-3 py-4 */}
        <View style={styles.sent}>
          <Face counterparty={{ kind: 'identityKey', value: identityKey }} avatarUrl={avatarUrl} size={64} />
          <View style={styles.sentAmount}>
            <RaisedAmount figure={bsvFigure(sent)} mark={sz => <BsvMark size={sz} />} size={36} color={palette.foreground} />
          </View>
          <BalancedText style={[font(400), styles.sentText, { color: palette.mutedForeground }]}>
            {`${first} just got a notification. You’ll find the request in your activity until it’s paid.`}
          </BalancedText>
          <View style={styles.sentDone}>
            <GlassButton label="Done" onPress={() => onOpenChange(false)} />
          </View>
        </View>
      </BottomSheet>
    )
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Request from ${first}`}
      description={requests.ready ? `${first} gets it in their Bitcoin SV Wallet.` : 'They’ll get a link that pays you this amount.'}
    >
      <View style={styles.requestAmount}>
        <TextInput
          value={amount}
          onChangeText={v => setAmount(v.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          placeholderTextColor={palette.mutedForeground + '80'}
          keyboardType="decimal-pad"
          autoFocus
          accessibilityLabel="Request amount in BSV"
          style={[font(800), styles.bigAmount, { color: palette.foreground }]}
        />
        <Text style={[font(800), styles.bigUnit, { color: sats ? palette.foreground : palette.mutedForeground + '80' }]}>BSV</Text>
      </View>
      {requests.ready && (
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="What’s it for? (optional)"
          placeholderTextColor={palette.mutedForeground}
          accessibilityLabel="Note"
          maxLength={120}
          style={[font(400), styles.note, { color: palette.foreground, backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
        />
      )}
      <GlassButton
        label={busy ? 'Sending…' : sats ? `Request ${bsvFigure(sats)} BSV` : 'Enter an amount'}
        disabled={!sats || busy}
        onPress={() => void request()}
      />
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, gap: 16 },
  flex: { flex: 1 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  who: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  name: { paddingTop: 4, fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  buttons: { flexDirection: 'row', gap: 8 },
  totals: { flexDirection: 'row', gap: 8 },
  total: { flex: 1, borderRadius: radii['2xl'], paddingHorizontal: 16, paddingVertical: 12 },
  totalValue: { fontSize: 18, lineHeight: 26, fontVariant: ['tabular-nums'] },
  none: { paddingVertical: 40 },
  day: { paddingBottom: 6, paddingLeft: 4, fontSize: 11, lineHeight: 16, letterSpacing: 1.6 },
  card: { borderRadius: radii['3xl'], padding: 4 },
  requestAmount: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  // no lineHeight on a big TextInput: iOS clips the tops of the figures to it; a height instead
  bigAmount: { minWidth: 30, fontSize: 48, height: 62, letterSpacing: -1.2, padding: 0, textAlign: 'center' },
  bigUnit: { fontSize: 48, lineHeight: 56, letterSpacing: -1.2 },
  sent: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  sentAmount: { paddingTop: 4 },
  sentText: { width: '100%', maxWidth: 240, textAlign: 'center', fontSize: 14, lineHeight: 22.75 },
  sentDone: { alignSelf: 'stretch', marginTop: 8 },
  note: { minHeight: 48, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, lineHeight: 20 }
})
