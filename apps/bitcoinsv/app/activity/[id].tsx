// A payment, receipt-style (the prototype's app/(wallet)/activity/[id]/page.tsx),
// as its own route (decision 11): who and when, the amount large, its state in
// the core's words, then the facts under a dashed rule, with the transaction
// on WhatsOnChain. The menu makes a PDF receipt on the phone, copies the id,
// opens the explorer, adds or takes the other side out of contacts, and
// cancels a payment parked offline through the core's own chain-checked
// cancel (cancelParkedPayment).
//
// Not here, unlike the prototype: hosted receipts (decision 11; the PDF is
// made on the phone instead), the support agent (Later), per-payment export
// exclusion, and network fee / block facts the core doesn't keep per action.
import React, { useEffect, useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../../src/ui/TextInput'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { ArrowDownLeft, ArrowUpRight, Ban, Copy, Ellipsis, ExternalLink, FileDown, Star, UserMinus, UserPlus, type LucideIcon } from 'lucide-react-native'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../../src/ui/Toast'
import { Handle } from '../../src/ui/Handle'
import { cancelParkedPayment, runCancelParkedFlow } from '@bsv/expo-wallet-toolbox/core/offline/cancelParked'
import { font, radii, usePalette } from '../../src/theme'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { GlassButton } from '../../src/ui/GlassButton'
import { Coin } from '../../src/ui/Coin'
import { CoinMark } from '../../src/ui/CoinMark'
import { BsvMark } from '../../src/ui/BsvMark'
import { RollingAmount } from '../../src/ui/RollingAmount'
import { Face } from '../../src/ui/Face'
import { PageHeader } from '../../src/ui/PageHeader'
import { enter, useReducedMotion } from '../../src/ui/motion'
import { bsvFigure, whenLabel } from '../../src/activity/format'
import { activityItem, useActivity } from '../../src/activity/useActivity'
import { TxRowSkeleton } from '../../src/activity/TxRow'
import { useContacts } from '../../src/contacts/useContacts'
import { receiptFileName, receiptHtml } from '../../src/activity/receipt'
import { sharePdf } from '../../src/ui/sharePdf'
import { addressUrl, explorerUrl } from '../../src/links/explorer'


const middle = (s: string, keep = 8) => (s.length > keep * 2 + 1 ? `${s.slice(0, keep)}…${s.slice(-keep)}` : s)
/** The receipt settles in top to bottom: a short rise and fade, each part a
 *  beat after the one above (fade-in slide-in-from-bottom-1 duration-400
 *  ease-out, delay 60 + i·45ms). */
const stagger = (i: number) => enter({ opacity: 0, translateY: 4, duration: 400, delay: 60 + i * 45, easing: 'ease-out' })

export default function TransactionDetail() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  // a cancel writes storage, which bumps the core's txStatusVersion: the list re-reads itself
  const { storage, managers, adminOriginator, selectedNetwork, mandalaSettlement } = useWallet()
  const contacts = useContacts()
  const [menu, setMenu] = useState(false)
  // motion-reduce:animate-none
  const still = useReducedMotion()
  const rise = (i: number) => (still ? null : stagger(i))
  const [cancelling, setCancelling] = useState(false)
  // Add to contacts: a label, if they like (the prototype's sheet)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  // what the list showed, at once; opened from elsewhere (a link, a restored
  // screen), it's read from the wallet, a page at a time until it's found
  const shownInList = id ? activityItem(id) : undefined
  const { items, more, loadMore, loadingMore } = useActivity({ limit: shownInList ? 1 : 50 })
  const tx = shownInList ?? (id ? items?.find(it => it.id === id) : undefined)
  const looking = !tx && (items === null || more || loadingMore)
  useEffect(() => {
    if (!tx && items && more && !loadingMore) void loadMore()
  }, [tx, items, more, loadingMore, loadMore])

  if (!tx) {
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="" />
          {looking ? (
            <TxRowSkeleton count={1} />
          ) : (
            <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>This payment isn’t in your activity any more.</Text>
          )}
        </View>
      </View>
    )
  }

  const key = tx.counterparty?.kind === 'identityKey' ? tx.counterparty.value : undefined
  const contact = key ? contacts.byKey.get(key.toLowerCase()) : undefined
  const Icon = tx.incoming ? ArrowDownLeft : ArrowUpRight
  const settled = tx.status.tone === 'settled'
  const parked = tx.offlineStatus === 'parked'

  const copyTxid = async () => {
    if (!tx.txid) return
    await Clipboard.setStringAsync(tx.txid)
    showToast('Transaction ID copied', { type: 'success' })
  }
  const openExplorer = () => tx.txid && void Linking.openURL(explorerUrl(selectedNetwork, tx.txid))

  const toggleFavourite = async () => {
    if (!contact) return
    const next = !contact.favourite
    await contacts.setFavourite(contact.identityKey, next)
    const first = contact.name.split(' ')[0]
    showToast(next ? `${first} added to favourites` : `${first} removed from favourites`, { type: 'success' })
  }

  const cancelParked = async () => {
    const pm = managers.permissionsManager
    if (!tx.txid || !storage || !pm || cancelling) return
    setCancelling(true)
    try {
      const outcome = await runCancelParkedFlow({
        cancel: ack =>
          cancelParkedPayment({
            storage: storage as never,
            wallet: pm as never,
            originator: adminOriginator,
            txid: tx.txid as string,
            settlement: tx.token ? mandalaSettlement : undefined,
            acknowledgedUnverifiable: ack
          }),
        confirmUnverifiable: () =>
          new Promise(resolve =>
            Alert.alert(
              'Cancel without checking?',
              'You’re offline, so whether the other person already sent this payment can’t be checked. If they did, cancelling won’t stop it.',
              [
                { text: 'Keep it', style: 'cancel', onPress: () => resolve(false) },
                { text: 'Cancel payment', style: 'destructive', onPress: () => resolve(true) }
              ]
            )
          )
      })
      const message = {
        cancelled: 'Payment cancelled. The money is back in your wallet.',
        'already-sent': 'It was already sent, so it can’t be cancelled.',
        'not-found': 'This payment couldn’t be found to cancel.',
        'unverifiable-offline': 'Kept. Try again when you’re online.'
      }[outcome]
      showToast(message, { type: outcome === 'cancelled' ? 'success' : 'info' })
      if (outcome === 'cancelled') router.back()
    } catch {
      showToast('The payment couldn’t be cancelled. Try again in a moment.', { type: 'error' })
    } finally {
      setCancelling(false)
    }
  }

  // a receipt made on the phone (decision 11: no hosted receipts)
  const downloadReceipt = async () => {
    try {
      await sharePdf(
        receiptHtml(tx, { who: contact?.name ?? (key ? middle(key) : undefined), explorer: tx.txid && !parked ? explorerUrl(selectedNetwork, tx.txid) : undefined }),
        receiptFileName(tx)
      )
    } catch {
      showToast('The receipt couldn’t be made. Try again.', { type: 'error' })
    }
  }

  const actions: { icon: LucideIcon; label: string; run: () => void; danger?: boolean }[] = [
    { icon: FileDown, label: 'Download receipt (PDF)', run: () => void downloadReceipt() },
    ...(tx.txid ? [{ icon: Copy, label: 'Copy transaction ID', run: () => void copyTxid() }] : []),
    ...(tx.txid && !parked ? [{ icon: ExternalLink, label: 'View on WhatsOnChain', run: openExplorer }] : []),
    ...(key
      ? contact
        ? [
            {
              icon: UserMinus,
              label: 'Remove from contacts',
              run: async () => {
                await contacts.remove(contact.identityKey)
                showToast(`${contact.name} removed from contacts`, { type: 'info' })
              }
            }
          ]
        : [{ icon: UserPlus, label: 'Add to contacts', run: () => startAdding() }]
      : []),
    ...(parked ? [{ icon: Ban, label: cancelling ? 'Cancelling…' : 'Cancel payment', run: () => void cancelParked(), danger: true }] : [])
  ]

  function startAdding() {
    setLabel('')
    setAdding(true)
  }
  // without a label, the shortened key
  const saveContact = async () => {
    if (!key) return
    const name = label.trim() || middle(key)
    await contacts.add({ identityKey: key, name, source: 'pay' })
    setAdding(false)
    showToast(`${name} added to contacts`, { type: 'success' })
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Status', value: tx.statusText },
    { label: 'Category', value: tx.incoming ? 'Payment received' : 'Payment sent' },
    ...(contact
      ? [
          {
            label: tx.incoming ? 'From' : 'To',
            value: (
              <View style={styles.inline}>
                <Pressable
                  onPress={() => router.push({ pathname: '/contacts/[key]', params: { key: contact.identityKey } })}
                  accessibilityRole="link"
                  accessibilityLabel={`${contact.name}, open their page`}
                  hitSlop={6}
                >
                  {/* the handle as the prototype's Handle shows it: plain, still opening their page */}
                  {contact.cachedHandle ? (
                    <Handle handle={contact.cachedHandle} style={[font(500), styles.small, { color: palette.foreground }]} />
                  ) : (
                    <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
                      {contact.name}
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => void toggleFavourite()}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={contact.favourite ? `Remove ${contact.name} from favourites` : `Add ${contact.name} to favourites`}
                  accessibilityState={{ selected: contact.favourite }}
                >
                  <Star size={16} color={contact.favourite ? palette.gold : palette.mutedForeground} fill={contact.favourite ? palette.gold : 'none'} />
                </Pressable>
              </View>
            )
          }
        ]
      : tx.counterparty && tx.counterparty.kind !== 'txid'
        ? [
            {
              label: `${tx.incoming ? 'From' : 'To'} ${tx.counterparty.kind === 'identityKey' ? 'identity key' : 'address'}`,
              value: (
                <ExternalValue
                  value={tx.counterparty.value}
                  isKey={tx.counterparty.kind === 'identityKey'}
                  network={selectedNetwork}
                  onAdd={tx.counterparty.kind === 'identityKey' ? startAdding : undefined}
                />
              )
            }
          ]
        : []),
    { label: 'Paid with', value: tx.token ? tx.token.unit : 'BitcoinSV (BSV)' },
    ...(tx.note ? [{ label: 'Note', value: tx.note }] : [])
  ]

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader
          title=""
          action={
            <Pressable onPress={() => setMenu(true)} accessibilityRole="button" accessibilityLabel="More" style={[styles.round, { backgroundColor: palette.secondary }]}>
              <Ellipsis size={16} color={palette.foreground} />
            </Pressable>
          }
        />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {/* who and when */}
        <Animated.View style={[styles.who, rise(0)]}>
          {tx.counterparty && tx.counterparty.kind !== 'txid' ? (
            <Face counterparty={tx.counterparty} avatarUrl={contact?.cachedAvatarUrl} size={72} />
          ) : (
            <Coin size={72} icon={<Icon size={56} color={palette.foreground} />} />
          )}
          <Text style={[font(700), styles.title, { color: palette.foreground }]}>{tx.title}</Text>
          {tx.createdAt && <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{whenLabel(tx.createdAt)}</Text>}
        </Animated.View>

        {/* amount */}
        <Animated.View style={[styles.amountBlock, rise(1)]}>
          {/* the coin rolls in from the edge, uncovering the figure (the prototype's) */}
          <RollingAmount
            sign={tx.incoming ? '+' : ''}
            figure={tx.token ? tx.token.figure.replace(/^[+−-]/, '') : bsvFigure(Math.abs(tx.sats ?? 0))}
            unit={tx.token && !/usd/i.test(tx.token.unit) ? tx.token.unit : undefined}
            mark={tx.token ? (/usd/i.test(tx.token.unit) ? s => <CoinMark coin={{ kind: 'token', ticker: tx.token!.unit }} size={s} /> : undefined) : s => <BsvMark size={s} />}
            size={48}
            color={tx.incoming ? palette.positive : palette.foreground}
          />
          <View style={[styles.pill, { backgroundColor: settled ? palette.foreground + '1a' : palette.secondary }]}>
            <Text style={[font(600), styles.small, { color: settled ? palette.foreground : palette.mutedForeground }]}>{tx.statusText}</Text>
          </View>
        </Animated.View>

        <Animated.View style={[styles.rule, { borderColor: palette.border }, rise(2)]} />

        {/* facts */}
        <View style={styles.facts}>
          {rows.map((r, i) => (
            <Animated.View key={r.label} style={[styles.fact, rise(3 + i)]}>
              <Text style={[font(400), styles.small, styles.factLabel, { color: palette.mutedForeground }]}>{r.label}</Text>
              <View style={styles.factValue}>
                {typeof r.value === 'string' ? (
                  <Text style={[font(500), styles.small, styles.right, { color: palette.foreground }]}>{r.value}</Text>
                ) : (
                  r.value
                )}
              </View>
            </Animated.View>
          ))}
          {tx.txid && (
            <Animated.View style={[styles.fact, rise(3 + rows.length)]}>
              <Text style={[font(400), styles.small, styles.factLabel, { color: palette.mutedForeground }]}>Transaction ID</Text>
              <View style={[styles.factValue, styles.inline]}>
                <Pressable onPress={openExplorer} disabled={parked} accessibilityRole="link" accessibilityLabel="View this transaction on WhatsOnChain" style={styles.flexShrink}>
                  <Text numberOfLines={1} style={[font(600), styles.mono, styles.link, { color: palette.foreground, textDecorationColor: palette.mutedForeground }]}>
                    {middle(tx.txid, 10)}
                  </Text>
                </Pressable>
                <Pressable onPress={() => void copyTxid()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Copy transaction ID">
                  <Copy size={16} color={palette.mutedForeground} />
                </Pressable>
              </View>
            </Animated.View>
          )}
        </View>
      </ScrollView>

      <BottomSheet open={menu} onOpenChange={setMenu} title="Payment">
        {actions.map(a => (
          <Pressable
            key={a.label}
            onPress={() => {
              setMenu(false)
              a.run()
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: palette.secondary }]}
          >
            <a.icon size={18} color={a.danger ? palette.destructive : palette.foreground} />
            <Text style={[font(500), styles.body15, { color: a.danger ? palette.destructive : palette.foreground }]}>{a.label}</Text>
          </Pressable>
        ))}
      </BottomSheet>
      {key && !contact && (
        <BottomSheet
          open={adding}
          onOpenChange={setAdding}
          title="Add to contacts"
          description="Add a label if you like, so you’ll recognise this identity key next time."
        >
          <View style={styles.inline}>
            <Face counterparty={{ kind: 'identityKey', value: key }} size={44} />
            <Text style={[font(500), styles.mono, { color: palette.mutedForeground }]}>Identity key · {middle(key)}</Text>
          </View>
          <TextInput
            value={label}
            onChangeText={setLabel}
            onSubmitEditing={() => void saveContact()}
            placeholder="Label (optional)"
            placeholderTextColor={palette.mutedForeground}
            autoFocus
            accessibilityLabel="Label (optional)"
            style={[font(400), styles.labelInput, { color: palette.foreground, backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
          />
          <GlassButton size="lg" label="Add contact" icon={<UserPlus size={18} color={palette.goldForeground} />} onPress={() => void saveContact()} />
        </BottomSheet>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  who: { alignItems: 'flex-start', gap: 4, paddingTop: 16 },
  title: { paddingTop: 16, fontSize: 24, lineHeight: 32, letterSpacing: -0.6 },
  small: { fontSize: 14, lineHeight: 20 },
  body15: { fontSize: 15, lineHeight: 20 },
  amountBlock: { alignItems: 'flex-start', gap: 12, paddingTop: 28 },
  pill: { borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 6 },
  rule: { marginVertical: 28, borderTopWidth: 1, borderStyle: 'dashed' },
  facts: { gap: 20, paddingBottom: 16 },
  fact: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  factLabel: { flexShrink: 0 },
  factValue: { flexShrink: 1, alignItems: 'flex-end' },
  right: { textAlign: 'right' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexShrink: { flexShrink: 1 },
  mono: { fontSize: 13, lineHeight: 18 },
  labelInput: { height: 48, borderRadius: 16, paddingHorizontal: 16, fontSize: 15 },
  iconBtn: { padding: 4, borderRadius: 6 },
  link: { textDecorationLine: 'underline' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 12 }
})

/**
 * The other side when it isn't a contact (the prototype's ExternalValue): an
 * identity key or address, shortened in the middle, with a copy button and,
 * for a key, one to add them to contacts (contacts are people, by identity
 * key: an address can't be one). An address opens on WhatsOnChain.
 */
function ExternalValue({ value, isKey, network, onAdd }: { value: string; isKey: boolean; network: string; onAdd?: () => void }) {
  const palette = usePalette()
  const kind = isKey ? 'identity key' : 'address'
  const copy = async () => {
    await Clipboard.setStringAsync(value)
    showToast(isKey ? 'Identity key copied' : 'Address copied', { type: 'success' })
  }
  return (
    <View style={styles.inline}>
      {/* add to contacts, then copy, in front of the value */}
      {onAdd && (
        <Pressable onPress={onAdd} accessibilityRole="button" accessibilityLabel={`Add this ${kind} to contacts`} hitSlop={6} style={styles.iconBtn}>
          <UserPlus size={16} color={palette.mutedForeground} />
        </Pressable>
      )}
      <Pressable onPress={() => void copy()} accessibilityRole="button" accessibilityLabel={isKey ? 'Copy identity key' : 'Copy address'} hitSlop={6} style={styles.iconBtn}>
        <Copy size={16} color={palette.mutedForeground} />
      </Pressable>
      {isKey ? (
        <Text style={[font(500), styles.mono, { color: palette.foreground }]}>{middle(value)}</Text>
      ) : (
        <Text
          accessibilityRole="link"
          onPress={() => void Linking.openURL(addressUrl(network, value))}
          style={[font(500), styles.mono, { color: palette.foreground, textDecorationLine: 'underline', textDecorationColor: palette.mutedForeground + '80' }]}
        >
          {middle(value)}
        </Text>
      )}
    </View>
  )
}
