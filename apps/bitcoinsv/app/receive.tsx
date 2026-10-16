// Get paid (the prototype's app/(wallet)/receive/page.tsx), on the shared
// core: a real QR of this wallet's pay link (peerPayLinkFor: the identity
// key, an optional amount, the message box to deliver to), in BitcoinSV or
// a stablecoin you hold. Payments are credited by the core's inbox task;
// while this screen is open it's asked to look every few seconds, so a
// payment shows up (the core's "payment arrived" toast) within moments.
//
// Two steps, as the existing app's request hub: the amount first (blank is
// "any amount"), with its coin and note, then how — Nearby, Share remote
// link, or To a BSV address. Only the chosen method's code is shown, so the
// screen never holds three ways to pay at once. Back returns to the amount.
//
// Nearby is the core's NearbyFlow as payee, embedded in the code's slot: a
// pairing code that takes the payment phone to phone over AWDL, BLE or the QR
// fountain, no internet needed (the note stays with the link; a nearby
// session has no field for it). Remote is the pay link: its QR, copy, and
// "Send" to contacts in their own wallet (src/requests). The address is
// today's plain BSV address (src/receive/AddressSheet).
//
// Not here, unlike the prototype: the bitcoinsv.com request link and public
// /@handle page (no server for them yet). The link shared is the pay link
// itself.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { BackHandler, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../src/ui/TextInput'
import Animated from 'react-native-reanimated'
import { useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy, Ellipsis, Link2, Radio, Send, Tag, Wallet } from 'lucide-react-native'
import {
  NO_MESSAGE_BOX,
  TaskCreditInbox,
  peerPayLinkFor,
  useWallet
} from '@bsv/expo-wallet-toolbox'
import {
  NearbyAdvisoryModal,
  NearbyFlow,
  formatTokenAmountWithUnit,
  parseTokenAmount,
  useMandala,
  useMessageBoxConfig,
  useOnline
} from '@bsv/expo-wallet-toolbox/ui'
import { nearbyAdvisory } from '@bsv/expo-wallet-toolbox/core/localpay/nearbyAdvisory'
import { showToast } from '../src/ui/Toast'
import type { TokenAssetInfo } from '@bsv/expo-wallet-toolbox/core/mandala/runtime'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { font, usePalette } from '../src/theme'
import { BottomSheet, afterSheetCloses } from '../src/ui/BottomSheet'
import { CoinMark } from '../src/ui/CoinMark'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { PayQr } from '../src/ui/PayQr'
import { PressScale } from '../src/ui/PressScale'
import { useFocusRing } from '../src/ui/focusRing'
import { AmountInput } from '../src/pay/AmountInput'
import { CoinButton } from '../src/pay/CoinButton'
import { formatMoney } from '../src/ui/Money'
import { BalancedText } from '../src/ui/BalancedText'
import { NotifyPrompt } from '../src/notify/NotifyPrompt'
import { AddressReceive } from '../src/receive/AddressSheet'
import { StickerSheet } from '../src/print/StickerSheet'
import { toWebLink } from '../src/links/webLinks'
import { LINK_DOMAIN } from '../src/links/linkDomain'
import { ShareRequestSheet } from '../src/requests/ShareRequestSheet'
import { useRequests } from '../src/requests/useRequests'
import { useDisplayCurrency } from '../src/state/displayCurrency'

const SATS_PER_BSV = 100_000_000
type Method = 'nearby' | 'remote' | 'address'
const METHOD_TITLES: Record<Method, string> = { nearby: 'Nearby', remote: 'Remote link', address: 'BSV address' }
/** How often to ask the inbox task to look while this screen is open (HandleReceive's poll). */
const LOOK_MS = 5000

export default function Receive() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  const { managers, adminOriginator, storage, switchingProfile } = useWallet()
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const mandala = useMandala()
  const { fromSats: fiatOf, dollarsOf, currency: displayCurrency } = useDisplayCurrency()

  const [identityKey, setIdentityKey] = useState('')
  const [handle, setHandle] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [asset, setAsset] = useState<TokenAssetInfo | null>(null)
  const [amount, setAmount] = useState('')
  // what it's for: travels in the code and link, and starts the payer's note
  const [note, setNote] = useState('')
  // a BitcoinSV Accepted Here sticker, for a label printer
  const [stickerOpen, setStickerOpen] = useState(false)
  // the overflow menu: the sticker
  const [menu, setMenu] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sharing, setSharing] = useState(false)
  const requests = useRequests()
  const online = useOnline()
  // how, once the amount is set; null is the first step
  const [method, setMethod] = useState<Method | null>(null)
  // bumped to mint a fresh nearby code (the flow mints once per mount)
  const [nearbyEpoch, setNearbyEpoch] = useState(0)
  // a payment in hand: the nearby view holds still, Back included
  const [nearbyBusy, setNearbyBusy] = useState(false)
  // the one-time heads-up before the OS's Local Network / Bluetooth prompts;
  // null until read, so a returning user never sees it flash
  const [advisorySeen, setAdvisorySeen] = useState<boolean | null>(null)
  const [advising, setAdvising] = useState(false)
  useEffect(() => {
    let alive = true
    void nearbyAdvisory.get().then(seen => alive && setAdvisorySeen(seen))
    return () => {
      alive = false
    }
  }, [])
  // the note field shows its ring only while you're in it
  const noteRing = useFocusRing(palette, '0 0 0 1px transparent')

  const wallet = managers.permissionsManager
  useEffect(() => {
    let alive = true
    if (switchingProfile) return
    wallet
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => alive && setIdentityKey(r.publicKey))
      .catch(() => {})
    storage
      ?.getKeyValue(HANDLE_KV_KEY)
      .then(v => alive && setHandle(v ?? null))
      .catch(() => {})
    storage
      ?.getKeyValue(DISPLAY_NAME_KV_KEY)
      .then(v => alive && setName(v ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [wallet, adminOriginator, storage, switchingProfile])

  // while you're here, payments are looked for every few seconds
  useFocusEffect(
    useCallback(() => {
      TaskCreditInbox.requestNow()
      const timer = setInterval(() => TaskCreditInbox.requestNow(), LOOK_MS)
      return () => clearInterval(timer)
    }, [])
  )

  // the amount, in satoshis or the token's base units; none is an open request
  const units = useMemo(() => {
    if (asset) return parseTokenAmount(amount, asset.decimals) ?? undefined
    const n = parseFloat(amount)
    return Number.isFinite(n) && n > 0 ? Math.round(n * SATS_PER_BSV) : undefined
  }, [amount, asset])
  const requested = units !== undefined && units > 0 ? units : undefined

  const box = messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX ? messageBoxUrl : undefined
  const link = identityKey
    ? asset
      ? peerPayLinkFor(identityKey, undefined, box, { assetId: asset.assetId, baseUnits: requested }, note)
      : peerPayLinkFor(identityKey, requested, box, undefined, note)
    : ''
  const refusal = asset && identityKey && mandala.runtime ? mandala.runtime.recipientRefusal(identityKey) : null

  const coin = asset ? ({ kind: 'token', ticker: asset.ticker } as const) : ({ kind: 'bsv' } as const)
  const coinName = asset ? `${asset.label} (${asset.ticker})` : 'BitcoinSV (BSV)'
  const requestedText =
    requested === undefined
      ? null
      : asset
        ? formatTokenAmountWithUnit(requested, asset)
        : `${(requested / SATS_PER_BSV).toFixed(8).replace(/\.?0+$/, '')} BSV`
  // what it's worth in money you know: the display currency, or US dollars
  // when that's BitcoinSV itself (never the BSV figure again; none on testnet)
  const worth = asset || requested === undefined ? null : displayCurrency.code === 'BSV' ? dollarsOf(requested) : fiatOf(requested)
  const fiat = worth == null ? null : formatMoney(worth, displayCurrency.code === 'BSV' ? 'dollars' : 'usd')

  const copyHandle = async () => {
    const text = handle ?? link
    if (!text) return
    await Clipboard.setStringAsync(text)
    showToast(handle ? `${handle} copied` : 'Pay link copied', { type: 'success' })
  }
  // once BSVA hosts the domain: the website link, which opens the app or the site
  const shared = toWebLink(link, LINK_DOMAIN)
  // what the pill shows: the key, shortened, without the message box host and
  // the rest of the query (copying and sharing still give the whole link)
  const shownLink =
    identityKey && shared.startsWith('peerpay:') ? `peerpay:${identityKey.slice(0, 8)}…${identityKey.slice(-6)}` : shared
  const copyLink = async () => {
    if (!link) return
    await Clipboard.setStringAsync(shared)
    // the link itself, so it's plain what was copied
    showToast('Link copied', { type: 'success', description: shared })
  }
  const share = () => {
    if (!link) return
    // dismissing the share sheet rejects on some platforms
    void Share.share({ message: shared }).catch(() => {})
  }
  const pick = (next: Method) => {
    if (next === 'nearby' && !advisorySeen) {
      // the heads-up first; null (not read yet) waits for it too
      if (advisorySeen === false) setAdvising(true)
      return
    }
    setMethod(next)
  }
  // back to the amount, unless a nearby payment is being taken
  const leave = useCallback(() => {
    if (nearbyBusy) return
    setMethod(null)
  }, [nearbyBusy])
  useFocusEffect(
    useCallback(() => {
      if (!method) return
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        leave()
        return true
      })
      return () => sub.remove()
    }, [method, leave])
  )
  // the amount can't change once a method is open, so this holds for its mount
  const nearbyInitial = useMemo(
    () => ({
      sats: requested,
      ...(asset
        ? {
            asset: {
              id: asset.assetId,
              label: asset.label,
              ticker: asset.ticker,
              decimals: asset.decimals,
              overlayUrl: asset.overlayUrl,
              overlayIdentityKey: asset.overlayIdentityKey
            }
          }
        : {})
    }),
    [requested, asset]
  )
  const methods: { key: Method; label: string; hint: string; icon: typeof Radio; disabled: boolean }[] = [
    { key: 'nearby', label: 'Nearby', hint: 'Show a code to someone next to you. No internet needed.', icon: Radio, disabled: !identityKey || !!refusal },
    {
      key: 'remote',
      label: 'Share remote link',
      hint: online ? 'A link to pay you, from anywhere' : 'Needs an internet connection',
      icon: Link2,
      disabled: !online || !identityKey
    },
    {
      key: 'address',
      label: 'To a BSV address',
      hint: asset ? `An address takes BSV only, not ${asset.ticker}` : online ? 'For a wallet or service that can’t use a link' : 'Needs an internet connection',
      icon: Wallet,
      disabled: !online || !!asset
    }
  ]
  const nearbyEmbed = useMemo(() => ({ qrSize: 204, onBusy: setNearbyBusy }), [])

  // an address can't carry an amount, so there it's said rather than asked
  const summary = requestedText
    ? method === 'address'
      ? `Tell them the amount: ${requestedText}. An address can’t carry it.`
      : `Requesting ${requestedText}`
    : 'Any amount'

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader
          title={method ? METHOD_TITLES[method] : 'Receive'}
          onBack={method ? leave : undefined}
          action={
            <View style={styles.headerActions}>
              <ViewInfo
                about="Receive"
                text="Set an amount if you want one, then choose how: nearby for someone next to you, a link for anyone anywhere, or a plain BSV address for another wallet."
              />
              {/* more ways to get paid, as the payment detail's menu */}
              {!method && !asset && (
                <Pressable onPress={() => setMenu(true)} accessibilityRole="button" accessibilityLabel="More" style={[styles.round, { backgroundColor: palette.secondary }]}>
                  <Ellipsis size={16} color={palette.foreground} />
                </Pressable>
              )}
            </View>
          }
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      >
        {method === null ? (
          <>
            {/* the amount: the number, then the coin's own mark, which opens the currency chooser */}
            <View style={styles.amountBlock}>
              <View style={styles.amountRow}>
                <AmountInput
                  value={amount}
                  onChange={v => setAmount(v.replace(/[^0-9.]/g, ''))}
                  size={48}
                  accessibilityLabel={`Requested amount in ${asset?.ticker ?? 'BSV'} (optional)`}
                />
                <CoinButton
                  coin={coin}
                  size={40}
                  onPress={() => setPicking(true)}
                  accessibilityLabel={`Currency: ${asset?.ticker ?? 'BSV'}. Change currency`}
                />
              </View>
              {fiat && (
                <Text style={[font(400), styles.small, { color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}>
                  ≈ {fiat}
                </Text>
              )}
              {/* what it's for: in the link, and on their side */}
              <Animated.View style={[styles.noteWrap, noteRing.style]}>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  {...noteRing.handlers}
                  placeholder="Add a note (optional)"
                  placeholderTextColor={palette.mutedForeground + 'b3'}
                  accessibilityLabel="Note (optional)"
                  maxLength={120}
                  returnKeyType="done"
                  style={[font(400), styles.note, { color: palette.foreground }]}
                />
              </Animated.View>
              <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                {requested ? 'Leave it at 0 to let them choose' : 'At 0, they choose how much'}
              </Text>
            </View>

            {/* how: only the chosen one's code is shown next */}
            <View>
              <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>METHOD</Text>
              <View style={styles.methods}>
                {methods.map(m => (
                  <Pressable
                    key={m.key}
                    onPress={() => pick(m.key)}
                    disabled={m.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={m.label}
                    accessibilityHint={m.hint}
                    accessibilityState={{ disabled: m.disabled }}
                    style={({ pressed }) => [
                      styles.methodRow,
                      { backgroundColor: pressed ? palette.accent : palette.secondary, opacity: m.disabled ? 0.45 : 1 }
                    ]}
                  >
                    <View style={[styles.methodIcon, { backgroundColor: palette.background }]}>
                      <m.icon size={18} color={palette.foreground} />
                    </View>
                    <View style={styles.flex}>
                      <Text style={[font(600), styles.body15, { color: palette.foreground }]}>{m.label}</Text>
                      <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{m.hint}</Text>
                    </View>
                    <ChevronRight size={18} color={palette.mutedForeground} />
                  </Pressable>
                ))}
              </View>
              {refusal && (
                <BalancedText style={[font(400), styles.xs, styles.center, styles.wide, { color: palette.mutedForeground, marginTop: 10 }]}>
                  {asset?.ticker} can’t be received here yet. {refusal}
                </BalancedText>
              )}
            </View>

            {/* your details */}
            <View>
              <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>YOUR DETAILS</Text>
              <View style={styles.details}>
                {[
                  { l: 'Name', v: name ?? '—' },
                  { l: 'Handle', v: handle ?? 'Not claimed yet' },
                  { l: 'Currency', v: coinName }
                ].map(r => (
                  <View key={r.l} style={styles.detail}>
                    <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{r.l}</Text>
                    <Text style={[font(500), styles.small, styles.detailValue, { color: palette.foreground }]}>{r.v}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        ) : (
          <View style={styles.top}>
            {/* what this code asks for, set on the step before */}
            <BalancedText style={[font(600), styles.small, styles.center, styles.wide, { color: requestedText && method !== 'address' ? palette.positive : palette.mutedForeground }]}>
              {summary}
              {method !== 'nearby' && !!note.trim() && <Text style={[font(400), { color: palette.mutedForeground }]}> · {note.trim()}</Text>}
            </BalancedText>

            {method === 'nearby' && (
              <>
                <NearbyFlow
                  key={nearbyEpoch}
                  role="payee"
                  embedded={nearbyEmbed}
                  initialRequest={nearbyInitial}
                  onExit={() => setNearbyEpoch(n => n + 1)}
                  dismissTo="/"
                />
                <BalancedText style={[font(400), styles.shareOtherText, styles.center, styles.wide, { color: palette.mutedForeground }]}>
                  They scan it and pay phone to phone, over Wi‑Fi or Bluetooth. No internet needed.
                </BalancedText>
              </>
            )}

            {method === 'remote' && (
              <>
                {/* tapping the code copies the handle too */}
                <PressScale
                  scale={0.98}
                  onPress={copyHandle}
                  accessibilityRole="button"
                  accessibilityLabel={handle ? `QR code. Tap to copy ${handle}` : 'QR code. Tap to copy your pay link'}
                >
                  {link ? <PayQr value={link} size={196} center={<CoinMark coin={coin} size={40} />} /> : <View style={styles.qrSpace} />}
                </PressScale>
                <View style={styles.linkBlock}>
                  {/* a link for this request: who, which currency, how much, what for */}
                  <Text style={[font(600), styles.xs, styles.linkLabel, { color: palette.mutedForeground }]}>
                    {requested ? 'Link for one payment' : 'Link to pay you any amount'}
                  </Text>
                  <View style={styles.linkRow}>
                    {/* tap copies; a long press hands it to the share sheet */}
                    <Pressable
                      onPress={copyLink}
                      onLongPress={share}
                      accessibilityRole="button"
                      accessibilityLabel="Copy your pay link"
                      accessibilityHint="Long press to share it"
                      style={({ pressed }) => [styles.linkPill, { backgroundColor: pressed ? palette.accent : palette.secondary }]}
                    >
                      <Text numberOfLines={1} ellipsizeMode="middle" style={[font(400), styles.linkText, { color: palette.mutedForeground }]}>
                        {shownLink || '…'}
                      </Text>
                      <Copy size={14} color={palette.mutedForeground} />
                    </Pressable>
                    {/* or straight to people in the app */}
                    <PressScale
                      scale={0.95}
                      onPress={() => (requests.ready && link && !refusal ? setSharing(true) : share())}
                      accessibilityRole="button"
                      accessibilityLabel={requested ? 'Send this request to people' : 'Send your link to people'}
                      style={[styles.send, { backgroundColor: palette.ink }]}
                    >
                      <Send size={14} color={palette.inkForeground} />
                      <Text style={[font(600), styles.small, { color: palette.inkForeground }]}>Send</Text>
                    </PressScale>
                  </View>
                  {/* any other app: the phone's share sheet */}
                  <Pressable onPress={share} accessibilityRole="button" hitSlop={8} style={styles.shareOther}>
                    <Text style={[font(400), styles.shareOtherText, { color: palette.mutedForeground }]}>Share the link another way</Text>
                  </Pressable>
                </View>
                <Text style={[font(400), styles.xs, styles.center, styles.foot, { color: palette.mutedForeground }]}>
                  {`Anyone with this link can pay you ${asset ? asset.ticker : 'BitcoinSV'}.\nPayments arrive in seconds and cost the sender under a cent.`}
                </Text>
              </>
            )}

            {method === 'address' && <AddressReceive active />}
          </View>
        )}
      </ScrollView>

      <BottomSheet open={picking} onOpenChange={setPicking} title="Choose currency">
        {[null, ...mandala.assets].map(a => {
          const on = (a?.assetId ?? null) === (asset?.assetId ?? null)
          return (
            <Pressable
              key={a?.assetId ?? 'bsv'}
              onPress={() => {
                setAsset(a)
                setAmount('')
                setPicking(false)
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary }]}
            >
              <CoinMark coin={a ? { kind: 'token', ticker: a.ticker } : { kind: 'bsv' }} size={40} />
              <View style={styles.flex}>
                <Text style={[font(600), styles.body15, { color: palette.foreground }]}>
                  {a ? a.label : 'BitcoinSV'}
                </Text>
                <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{a ? a.ticker : 'BSV'}</Text>
              </View>
              {on && <Check size={18} color={palette.foreground} />}
            </Pressable>
          )
        })}
      </BottomSheet>
      <StickerSheet open={stickerOpen} onOpenChange={setStickerOpen} />
      <BottomSheet open={menu} onOpenChange={setMenu} title="Get paid">
        {[{ label: 'Print an Accepted here sticker', hint: 'For a shop’s counter, on a label printer', icon: Tag, run: () => setStickerOpen(true) }].map(a => (
          <Pressable
            key={a.label}
            onPress={() => {
              setMenu(false)
              // the next sheet once this one has gone
              afterSheetCloses(a.run)
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: palette.secondary }]}
          >
            <a.icon size={18} color={palette.foreground} />
            <View style={styles.flex}>
              <Text style={[font(500), styles.body15, { color: palette.foreground }]}>{a.label}</Text>
              <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{a.hint}</Text>
            </View>
          </Pressable>
        ))}
      </BottomSheet>
      <ShareRequestSheet
        open={sharing}
        onOpenChange={setSharing}
        units={requested}
        note={note}
        asset={asset ? { assetId: asset.assetId, ticker: asset.ticker, decimals: asset.decimals } : undefined}
        link={link}
      />
      <NearbyAdvisoryModal
        visible={advising}
        onCancel={() => setAdvising(false)}
        onContinue={() => {
          void nearbyAdvisory.set()
          setAdvisorySeen(true)
          setAdvising(false)
          setMethod('nearby')
        }}
      />
      <NotifyPrompt />
    </View>
  )
}

const styles = StyleSheet.create({
  // mt-2 w-64 rounded-full bg-transparent px-4 py-1.5 text-center text-sm
  noteWrap: { width: 256, marginTop: 8, borderRadius: 999 },
  note: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  amountBlock: { alignItems: 'center', gap: 4, paddingTop: 8, alignSelf: 'stretch' },
  linkLabel: { paddingBottom: 8 },
  shareOther: { marginTop: 10 },
  shareOtherText: { fontSize: 13, lineHeight: 18 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  methods: { gap: 8, paddingTop: 4 },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 12 },
  methodIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 12 },
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 20 },
  top: { alignItems: 'center', gap: 16, paddingVertical: 8 },
  qrSpace: { width: 236, height: 236 },
  refusal: {
    width: 236,
    minHeight: 236,
    borderRadius: 24,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  linkBlock: { alignItems: 'center', alignSelf: 'stretch' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' },
  linkPill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 14
  },
  linkText: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
  send: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  eyebrow: { paddingBottom: 6, paddingLeft: 4, fontSize: 11, lineHeight: 16, letterSpacing: 1.6 },
  details: { gap: 16, paddingHorizontal: 4, paddingTop: 8 },
  detail: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 },
  detailValue: { flexShrink: 1, textAlign: 'right' },
  foot: { lineHeight: 19 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  center: { textAlign: 'center' },
  // full width: Android clips the last word of shrink-wrapped centred text in a custom font
  wide: { alignSelf: 'stretch' },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 10
  }
})
