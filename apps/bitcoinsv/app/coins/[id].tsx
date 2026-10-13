// One coin (the prototype's app/(wallet)/coins/[id]/page.tsx): its mark (which
// switches to another coin you hold), what you hold and its worth in the
// display currency, how its price behaves, then its own activity by day, or,
// before any, where money in it comes from. Scrolled past the hero, the coin
// docks in the header as a pill that switches too.
// Not here: the prototype's Top up, Swap and Withdraw tiles (Later), its
// balance chart (Later), and its stablecoin issuer sheet's figures, which
// were made up: a stablecoin opens what the shared core knows about it.
import React, { useEffect, useMemo, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink } from 'lucide-react-native'
import { showToast } from '../../src/ui/Toast'
import { font, usePalette } from '../../src/theme'
import { PageHeader } from '../../src/ui/PageHeader'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { GlassButton } from '../../src/ui/GlassButton'
import { CoinMark } from '../../src/ui/CoinMark'
import { Coin } from '../../src/ui/Coin'
import { Money, formatAmount } from '../../src/ui/Money'
import { RaisedAmount } from '../../src/ui/RollingAmount'
import { BsvMark } from '../../src/ui/BsvMark'
import { SoftEllipse } from '../../src/ui/Soft'
import { BalancedText } from '../../src/ui/BalancedText'
import { TxRow, TxRowSkeleton } from '../../src/activity/TxRow'
import { groupByDay } from '../../src/activity/format'
import { useActivity } from '../../src/activity/useActivity'
import { isDollar, useAssets, type Asset } from '../../src/state/useAssets'
import { CoinFlag } from '../../src/ui/Flag'
import { usePrefs } from '../../src/state/prefs'
import { useDisplayCurrency } from '../../src/state/displayCurrency'
import { coinBob, enter, useReducedMotion } from '../../src/ui/motion'

/** The header's crossfade between the name and the docked pill (transition-all duration-300). */
const DOCK_MOTION = { transitionProperty: ['opacity', 'transform'] as ('opacity' | 'transform')[], transitionDuration: 300 }

/**
 * The currency picker's mark (currency-picker.tsx, variant icon): the coin
 * with a small chevron badge so it reads as tappable, 16px at 40, ~19px at 64.
 */
function PickerMark({ mark, size, badge }: { mark: (size: number) => React.ReactNode; size: number; badge: boolean }) {
  const palette = usePalette()
  const b = Math.max(16, Math.round(size * 0.3))
  return (
    <View>
      {mark(size)}
      {badge && (
        // -bottom-0.5 -right-0.5, ring-2 ring-background
        <View style={[styles.badge, { width: b, height: b, borderRadius: b / 2, backgroundColor: palette.ink, boxShadow: `0 0 0 2px ${palette.background}` }]}>
          <ChevronDown size={b * 0.75} color={palette.inkForeground} strokeWidth={2.5} />
        </View>
      )}
    </View>
  )
}

export default function CoinPage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { assets, known } = useAssets()
  const asset = assets.find(a => a.id === id)
  if (asset) return <CoinDetail asset={asset} />
  // a stablecoin's balance is still being read: not gone, just not here yet
  if (!known) return <CoinPending />
  // a coin you no longer hold has nothing to show: back where you came from
  return <CoinGone />
}

/** The page's frame while its stablecoin is read, so the open doesn't flash. */
function CoinPending() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <PageHeader title="" />
      </View>
    </View>
  )
}

/**
 * Leaves for the screen below, rather than pushing Home on top of Home (what
 * a Redirect to "/" did from a coin opened on Home).
 */
function CoinGone() {
  const router = useRouter()
  useEffect(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [router])
  return <CoinPending />
}

function CoinDetail({ asset }: { asset: Asset }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const prefs = usePrefs()
  const still = useReducedMotion()
  const [about, setAbout] = useState(false)
  const [picking, setPicking] = useState(false)
  // the hero has scrolled under the header
  const [docked, setDocked] = useState(false)
  const [headerH, setHeaderH] = useState(64)
  const [heroBottom, setHeroBottom] = useState(0)
  const { assets } = useAssets()
  const canSwitch = assets.length > 1
  const bsv = asset.id === 'bsv'
  const coin = bsv ? ({ kind: 'bsv' } as const) : ({ kind: 'token', ticker: asset.ticker } as const)
  const mark = (size: number) => <CoinMark coin={coin} size={size} />
  // its worth in the display currency, unless that's the coin itself
  const display = useDisplayCurrency()
  const showFiat = asset.fiat != null && !(bsv && display.currency.code === 'BSV')
  const amountText = prefs.privacy ? '••••' : bsv ? `${asset.amount} BSV` : `${asset.figure} ${asset.ticker}`
  const { items, more, loadMore } = useActivity()
  const groups = useMemo(
    () => groupByDay((items ?? []).filter(tx => (bsv ? !tx.token : tx.token?.assetId === asset.id))),
    [items, bsv, asset.id]
  )
  const top = insets.top + headerH

  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: top + 8, paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
        onScroll={e => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
          // docked once the hero has gone under the header
          if (heroBottom) setDocked(contentOffset.y > heroBottom - top)
          if (more && layoutMeasurement.height + contentOffset.y > contentSize.height - 400) void loadMore()
        }}
        scrollEventThrottle={64}
      >
        <View
          style={styles.hero}
          onLayout={e => setHeroBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
        >
          {/* the coin's mark doubles as a switcher, like in Pay */}
          <Pressable
            onPress={() => setPicking(true)}
            disabled={!canSwitch}
            accessibilityRole="button"
            accessibilityLabel={canSwitch ? `${asset.name}. Switch currency` : asset.name}
            style={({ pressed }) => pressed && { transform: [{ scale: 0.96 }] }}
          >
            <PickerMark mark={mark} size={64} badge={canSwitch} />
          </Pressable>
          {/* AnimatedMoney with ticker: the figure, its decimals raised, the
              ticker spelled out; it fades and rises in (slide-in-from-bottom-2) */}
          <Animated.View
            key={asset.id}
            accessible
            accessibilityLabel={`${asset.name}, ${prefs.privacy ? 'balance hidden' : `${bsv ? asset.amount : asset.figure} ${asset.ticker}`}`}
            style={[styles.amount, still ? null : enter({ translateY: 8, duration: 300 })]}
          >
            {prefs.privacy ? (
              <Text style={[font(800), styles.big, { color: palette.foreground }]}>••••</Text>
            ) : (
              <RaisedAmount figure={bsv ? formatAmount(asset.amount) : (asset.figure ?? '0')} unit={asset.ticker} size={36} color={palette.foreground} />
            )}
          </Animated.View>
          {showFiat && (
            <Money amount={asset.fiat!} unit="usd" privacy={prefs.privacy} style={[font(400), styles.small, { color: palette.mutedForeground }]} />
          )}
          {/* how its price behaves, with its flag; a stablecoin's opens what's known about it */}
          <Pressable
            onPress={bsv ? undefined : () => setAbout(true)}
            disabled={bsv}
            accessibilityRole={bsv ? 'text' : 'button'}
            // the flag is decoration: the pill reads as its words
            accessibilityLabel={asset.peg}
            style={[styles.peg, { backgroundColor: palette.secondary }]}
          >
            {bsv ? <BsvMark size={12} ink /> : isDollar(asset.ticker) ? <CoinFlag country="us" height={11} /> : <CoinMark coin={coin} size={11} />}
            <Text style={[font(600), styles.xs, { color: palette.foreground }]}>{asset.peg}</Text>
            {!bsv && (
              <View style={styles.pegChevron}>
                <ChevronRight size={14} color={palette.mutedForeground} />
              </View>
            )}
          </Pressable>
        </View>

        {/* not read yet: placeholders, not "no activity yet" */}
        {items === null ? (
          <View style={styles.rows}>
            <TxRowSkeleton count={4} />
          </View>
        ) : groups.length === 0 ? (
          <EmptyCoinActivity asset={asset} />
        ) : (
          groups.map(g => (
            <View key={g.label}>
              <Text style={[font(600), styles.day, { color: palette.mutedForeground }]}>{g.label.toUpperCase()}</Text>
              <View style={styles.rows}>
                {g.items.map(tx => (
                  <TxRow key={tx.id} tx={tx} />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* see-through over the hero; frosted once something scrolls under it */}
      <Animated.View
        onLayout={e => setHeaderH(e.nativeEvent.layout.height - insets.top)}
        style={[
          styles.header,
          { paddingTop: insets.top, backgroundColor: docked ? palette.background + 'cc' : palette.background + '00' },
          { transitionProperty: 'backgroundColor', transitionDuration: 300 }
        ]}
      >
        <PageHeader
          title={asset.name}
          onBack={() => router.back()}
          center={
            <View style={styles.dock}>
              {/* the name, leaving as the pill arrives */}
              <Animated.Text
                aria-hidden
                numberOfLines={1}
                style={[
                  font(700),
                  styles.dockTitle,
                  { color: palette.foreground, opacity: docked ? 0 : 1, transform: [{ translateY: docked ? -12 : 0 }] },
                  DOCK_MOTION
                ]}
              >
                {asset.name}
              </Animated.Text>
              {/* the docked coin: switcher, balance, and its value in your currency */}
              <Animated.View
                pointerEvents={docked ? 'auto' : 'none'}
                accessibilityElementsHidden={!docked}
                importantForAccessibility={docked ? 'auto' : 'no-hide-descendants'}
                style={[styles.dockPill, { opacity: docked ? 1 : 0, transform: [{ translateY: docked ? 0 : 12 }] }, DOCK_MOTION]}
              >
                <Pressable
                  onPress={() => canSwitch && setPicking(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`${asset.name}, ${amountText}${canSwitch ? '. Switch currency' : ''}`}
                  style={({ pressed }) => [
                    styles.pill,
                    { backgroundColor: palette.card, boxShadow: `0 2px 14px -4px rgba(20,24,40,0.2), 0 0 0 1px ${palette.border}` },
                    pressed && { transform: [{ scale: 0.98 }] }
                  ]}
                >
                  <PickerMark mark={mark} size={30} badge={canSwitch} />
                  <View>
                    <Text style={[font(700), styles.small, { color: palette.foreground, fontVariant: ['tabular-nums'] }]}>{amountText}</Text>
                    {showFiat && (
                      <Money amount={asset.fiat!} unit="usd" privacy={prefs.privacy} style={[font(400), styles.tiny, { color: palette.mutedForeground }]} />
                    )}
                  </View>
                </Pressable>
              </Animated.View>
            </View>
          }
        />
      </Animated.View>

      <BottomSheet open={picking} onOpenChange={setPicking} title="Switch currency">
        {assets.map(a => {
          const on = a.id === asset.id
          return (
            <Pressable
              key={a.id}
              onPress={() => {
                setPicking(false)
                if (!on) router.replace({ pathname: '/coins/[id]', params: { id: a.id } })
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary }]}
            >
              <CoinMark coin={a.id === 'bsv' ? { kind: 'bsv' } : { kind: 'token', ticker: a.ticker }} size={40} />
              <View style={styles.flex}>
                <Text style={[font(600), styles.body, { color: palette.foreground }]}>{a.name}</Text>
                <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{a.ticker}</Text>
              </View>
              {on && <Check size={18} color={palette.foreground} />}
            </Pressable>
          )
        })}
      </BottomSheet>

      {asset.token && (
        <BottomSheet open={about} onOpenChange={setAbout} title={`About ${asset.ticker}`} description={asset.name}>
          <View style={styles.facts}>
            {asset.token.issuerName ? <Fact label="Issued by" value={asset.token.issuerName} /> : null}
            <Fact label="Ticker" value={asset.ticker} />
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(asset.id)
                showToast('Asset ID copied', { type: 'success' })
              }}
              accessibilityRole="button"
              accessibilityLabel="Copy asset ID"
              style={[styles.fact, { backgroundColor: palette.secondary + 'b3' }]}
            >
              <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>Asset ID</Text>
              <View style={styles.idRow}>
                <Text numberOfLines={1} ellipsizeMode="middle" style={[font(600), styles.small, styles.flex, { color: palette.foreground }]}>
                  {asset.id}
                </Text>
                <Copy size={14} color={palette.mutedForeground} />
              </View>
            </Pressable>
            <Pressable
              onPress={() => void Linking.openURL(`https://whatsonchain.com/tx/${asset.id.split('_')[0].split('.')[0]}`)}
              accessibilityRole="link"
              style={styles.link}
            >
              <Text style={[font(600), styles.small, { color: palette.foreground, textDecorationLine: 'underline' }]}>See it on WhatsOnChain</Text>
              <ExternalLink size={14} color={palette.foreground} />
            </Pressable>
            <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
              {asset.ticker} is issued and can be paused by {asset.token.issuerName ?? 'its issuer'}. Your BSV is never affected.
            </Text>
          </View>
        </BottomSheet>
      )}
    </View>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  const palette = usePalette()
  return (
    <View style={[styles.fact, { backgroundColor: palette.secondary + 'b3' }]}>
      <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{label}</Text>
      <Text style={[font(600), styles.small, { color: palette.foreground }]}>{value}</Text>
    </View>
  )
}

/** The coin itself, bobbing in its own light, with where money comes from. */
function EmptyCoinActivity({ asset }: { asset: Asset }) {
  const palette = usePalette()
  const router = useRouter()
  const still = useReducedMotion()
  const bsv = asset.id === 'bsv'
  return (
    <View style={styles.empty}>
      <View style={styles.coinWrap}>
        {/* size-44 rounded-full blur-3xl: gold for BitcoinSV, a grey wash for a token */}
        <SoftEllipse
          frame={{ left: -32, top: -32, width: 176, height: 176 }}
          color={bsv ? palette.gold : palette.foreground}
          opacity={bsv ? 0.25 : 0.1}
          blur={64}
        />
        <Animated.View
          style={still ? null : { animationName: coinBob, animationDuration: 5000, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }}
        >
          <Coin coin={bsv ? { kind: 'bsv' } : { kind: 'token', ticker: asset.ticker }} />
        </Animated.View>
      </View>
      <View style={styles.emptyCopy}>
        <BalancedText style={[font(700), styles.h2, { color: palette.foreground }]}>No {asset.ticker} activity yet</BalancedText>
        <BalancedText style={[font(400), styles.emptyBody, { color: palette.mutedForeground }]}>
          {`Get paid in ${bsv ? 'BSV' : asset.ticker}. Every move shows up here.`}
        </BalancedText>
      </View>
      <View style={styles.emptyButtons}>
        <View style={styles.flex}>
          <GlassButton label="Get paid" onPress={() => router.push('/receive')} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 16 },
  header: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16 },
  // the centre slot: h-10, the name and the pill stacked in it
  dock: { alignSelf: 'stretch', height: 40, alignItems: 'center', justifyContent: 'center' },
  dockTitle: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  dockPill: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // flex-col items-center gap-2 py-4
  hero: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  amount: { paddingTop: 8 },
  big: { fontSize: 36, lineHeight: 44, letterSpacing: -1 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  tiny: { fontSize: 11, lineHeight: 14 },
  body: { fontSize: 15, lineHeight: 20 },
  badge: { position: 'absolute', right: -2, bottom: -2, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 999, paddingVertical: 4, paddingLeft: 4, paddingRight: 16 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, paddingHorizontal: 8, paddingVertical: 10 },
  flex: { flex: 1 },
  // mt-1 rounded-full px-3.5 py-1 gap-1.5
  peg: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 4 },
  pegChevron: { marginRight: -4 },
  day: { fontSize: 11, lineHeight: 16, letterSpacing: 1.6, paddingBottom: 6, paddingLeft: 4 },
  rows: { marginHorizontal: -8 },
  // flex-col items-center gap-5 py-10
  empty: { alignItems: 'center', gap: 20, paddingVertical: 40 },
  coinWrap: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  emptyCopy: { width: '100%', maxWidth: 320, alignItems: 'center', gap: 6, paddingTop: 8 },
  h2: { alignSelf: 'stretch', fontSize: 20, lineHeight: 28, letterSpacing: -0.5, textAlign: 'center' },
  emptyBody: { alignSelf: 'stretch', textAlign: 'center', fontSize: 14, lineHeight: 22.75 },
  emptyButtons: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: 320 },
  facts: { gap: 8 },
  fact: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4 }
})
