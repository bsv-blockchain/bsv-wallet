// Send to people (the prototype's components/share-request-sheet.tsx): pick
// contacts, and each gets this request in their Bitcoin SV Wallet (with an
// amount: a request, kept in your activity until it's paid; without one:
// your pay link, to pay you any amount). From Receive.
//
// The note is written on Receive and shows in the summary, as the prototype's.
//
// Not here, unlike the prototype: an @handle that isn't a contact (add them
// in Contacts first).
import React, { useEffect, useMemo, useState } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { TextInput } from '../ui/TextInput'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, Search } from 'lucide-react-native'
import { showToast } from '../ui/Toast'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { Face } from '../ui/Face'
import { GlassButton } from '../ui/GlassButton'
import { BalancedText } from '../ui/BalancedText'
import { BsvMark } from '../ui/BsvMark'
import { RaisedAmount } from '../ui/RollingAmount'
import { useFocusRing } from '../ui/focusRing'
import { radii } from '../theme/tokens'
import { useContacts } from '../contacts/useContacts'
import { amountText, useRequests } from './useRequests'
import type { PaymentRequest } from './requests'

export function ShareRequestSheet({
  open,
  onOpenChange,
  units,
  asset,
  link,
  note: given = ''
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** satoshis or the token's base units; none is "pay me any amount" */
  units?: number
  asset?: PaymentRequest['asset']
  link: string
  /** what it's for (written on Receive) */
  note?: string
}) {
  const palette = usePalette()
  const contacts = useContacts()
  const requests = useRequests()
  const [query, setQuery] = useState('')
  const note = given.trim()
  const ring = useFocusRing(palette)
  // h-[88dvh]: the sheet's body fills what's left under its header
  const { height: screen } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // with the keyboard up, it fits in what's left above it
  const [keyboard, setKeyboard] = useState(0)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboard(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  const bodyHeight = Math.max(240, Math.min(screen * 0.88, screen - keyboard - insets.top - 24) - SHEET_HEADER - Math.max(40, insets.bottom + 16))
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const mine = (contacts.list ?? []).filter(c => !c.removedAt)
    return (q ? mine.filter(c => `${c.name} ${c.cachedHandle ?? ''}`.toLowerCase().includes(q)) : mine).sort((a, b) =>
      a.favourite !== b.favourite ? (a.favourite ? -1 : 1) : a.name.localeCompare(b.name)
    )
  }, [contacts.list, query])
  const nameOf = (key: string) => contacts.byKey.get(key.toLowerCase())?.name ?? 'them'
  const toggle = (key: string) => setPicked(ps => (ps.includes(key) ? ps.filter(k => k !== key) : [...ps, key]))

  const send = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    const results = await Promise.allSettled(
      picked.map(to =>
        units
          ? requests.ask({ to, name: nameOf(to), units, asset, note, link })
          : requests.sendLink({ to, link, note })
      )
    )
    setBusy(false)
    const sent = picked.filter((_, i) => results[i].status === 'fulfilled')
    if (!sent.length) {
      showToast('That didn’t go through. Try again in a moment.', { type: 'error' })
      return
    }
    const first = nameOf(sent[0]).split(' ')[0]
    const who = sent.length === 1 ? first : `${first} and ${sent.length - 1} other${sent.length > 2 ? 's' : ''}`
    const missed = picked.length - sent.length
    showToast(`${units ? 'Request' : 'Link'} sent to ${who}`, {
      type: missed ? 'error' : 'success',
      description: missed
        ? `${missed} didn’t go through. Try them again.`
        : units
          ? 'You’ll find it in your activity until it’s paid.'
          : undefined
    })
    setPicked(ps => ps.filter(k => !sent.includes(k)))
    if (!missed) {
      setQuery('')
      onOpenChange(false)
    }
  }

  const label =
    picked.length === 0
      ? 'Pick people'
      : `Send to ${picked.length === 1 ? nameOf(picked[0]).split(' ')[0] : `${picked.length} people`}`

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title={units ? 'Send request' : 'Send your link'} description="They’ll get it in their Bitcoin SV Wallet.">
      <View style={[styles.body, { height: bodyHeight }]}>
        {/* what they'll get */}
        <View style={[styles.what, { backgroundColor: palette.secondary + 'b3' }]}>
          <View style={styles.middle}>
            <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{units ? 'One payment of' : 'Pay me any amount'}</Text>
            {units ? (
              <SummaryAmount text={amountText({ units, asset })} bsv={!asset} color={palette.foreground} />
            ) : (
              <Text numberOfLines={1} ellipsizeMode="middle" style={[font(400), styles.xs, { color: palette.foreground }]}>
                {link}
              </Text>
            )}
          </View>
          {!!note && (
            <Text numberOfLines={1} style={[font(400), styles.small, styles.note, { color: palette.mutedForeground }]}>
              “{note}”
            </Text>
          )}
        </View>
        <Animated.View style={[styles.search, { backgroundColor: palette.card }, ring.style]}>
          <Search size={16} color={palette.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            {...ring.handlers}
            placeholder="Name or @handle"
            placeholderTextColor={palette.mutedForeground}
            accessibilityLabel="Search contacts"
            autoCorrect={false}
            autoCapitalize="none"
            style={[font(400), styles.searchInput, { color: palette.foreground }]}
          />
        </Animated.View>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {list.map(c => {
            const on = picked.includes(c.identityKey)
            return (
              <Pressable
                key={c.identityKey}
                onPress={() => toggle(c.identityKey)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={c.name}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
              >
                <Face counterparty={{ kind: 'identityKey', value: c.identityKey }} avatarUrl={c.cachedAvatarUrl} size={40} />
                <View style={styles.middle}>
                  <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
                    {c.name}
                  </Text>
                  {c.cachedHandle && (
                    <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                      {c.cachedHandle}
                    </Text>
                  )}
                </View>
                <Animated.View
                  style={[
                    styles.tick,
                    on ? { backgroundColor: palette.ink, boxShadow: `0 0 0 1px ${palette.ink}` } : { boxShadow: `0 0 0 1px ${palette.border}` },
                    { transitionProperty: ['backgroundColor', 'boxShadow'], transitionDuration: 150 }
                  ]}
                >
                  {on && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
                </Animated.View>
              </Pressable>
            )
          })}
          {contacts.list !== null && list.length === 0 && (
            <BalancedText style={[font(400), styles.small, styles.none, { color: palette.mutedForeground }]}>
              {query.trim() ? `No one matches “${query.trim()}”.` : 'No contacts yet. Add someone by their @handle in Contacts.'}
            </BalancedText>
          )}
        </ScrollView>
        <GlassButton label={label} loading={busy} disabled={!picked.length} onPress={() => void send()} />
      </View>
    </BottomSheet>
  )
}

/** The BottomSheet's handle and header (title and one line), above its body. */
const SHEET_HEADER = 86

/** "One payment of": the figure raised, BitcoinSV with its mark (Money raised, text-2xl). */
function SummaryAmount({ text, bsv, color }: { text: string; bsv: boolean; color: string }) {
  const at = text.lastIndexOf(' ')
  const figure = at > 0 ? text.slice(0, at) : text
  const unit = at > 0 ? text.slice(at + 1) : undefined
  return <RaisedAmount figure={figure} unit={bsv ? undefined : unit} mark={bsv ? m => <BsvMark size={m} /> : undefined} size={24} color={color} />
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  what: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  note: { maxWidth: '45%', textAlign: 'right' },
  // the prototype's Input at h-11 rounded-2xl
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii['2xl'], paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 16, padding: 0 },
  list: { flex: 1, marginHorizontal: -8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  middle: { flex: 1, minWidth: 0 },
  tick: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  none: { paddingVertical: 32, textAlign: 'center', alignSelf: 'stretch' },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 }
})
