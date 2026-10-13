// Home, as the prototype's app/(wallet)/page.tsx in its Now state: top bar,
// total balance, quick actions, the BSV row, the first-run checklist and the
// first-steps card stack. Balances, backup state and the vault gate come from
// the shared wallet; a wallet with no activity yet is the new-wallet Home.
// The top bar's scan button signs in to websites (app/sign-in.tsx).
//
// On launch, Home is drawn at once under the native splash (on iOS, Home's top
// itself) while the wallet opens behind Face ID: the same layout as last time
// (prefs.homeShape: how many coins and payments, nothing more; a likely one
// before there's a last time), with pulsing placeholders where the figures and
// payments go. Taps made meanwhile happen once it's open.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { hideSplash } from '../src/ui/splash'
import { requestFeedback } from '../src/feedback/feedback'
import Animated from 'react-native-reanimated'
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isVaultEnabled } from '@bsv/expo-wallet-toolbox'
import { font, usePalette } from '../src/theme'
import { GlassButton } from '../src/ui/GlassButton'
import { setPref, usePrefs } from '../src/state/prefs'
import { useHomeData } from '../src/state/useHomeData'
import { useWalletPresence } from '../src/state/useWalletPresence'
import { usePendingHandleClaim } from '../src/state/useFirstWallet'
import { randomAvatarBg, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { EASE_OUT_QUINT, enter, enterRise, useReducedMotion } from '../src/ui/motion'
import { BalancedText } from '../src/ui/BalancedText'
import { TopBar } from '../src/home/TopBar'
import { BalanceHero } from '../src/home/BalanceHero'
import { ACTION_ICONS, QuickActions, type QuickAction } from '../src/home/QuickActions'
import { AssetRow, AssetRowSkeleton } from '../src/home/CoinRow'
import { useAssets } from '../src/state/useAssets'
import { SetupChecklist } from '../src/home/SetupChecklist'
import { HomeCards } from '../src/home/HomeCards'
import { SmallCards } from '../src/home/SmallCards'
import { BackupNudge } from '../src/home/BackupNudge'
import { BackupSheet } from '../src/backup/BackupSheet'
import { SyncSheet, useSyncEnabled } from '../src/sync/SyncSheet'
import { HomeTour } from '../src/tour/HomeTour'
import { Wallets } from '../src/home/Wallets'
import { setShowAgain, useShowAgain } from '../src/tour/showAgain'
import { HelpSheet } from '../src/settings/HelpSheet'
import { tourTarget } from '../src/tour/targets'
import { TxRow, TxRowSkeleton } from '../src/activity/TxRow'
import { useActivity } from '../src/activity/useActivity'
import { ChevronRight, Users } from 'lucide-react-native'
import { setTourVideo } from '../src/tour/TourVideo'

/** Home has already made its entrance this session (survives navigation, not a restart). */
let entered = false
/**
 * The launch drew Home while its wallet was still opening (from prefs.homeShape):
 * the bar, total and buttons were already in place (on iOS, in the native
 * splash too), so they don't rise in. Set once, as Home first draws.
 */
const launch: { drewOpening: boolean | null } = { drewOpening: null }
/** When Home first drew, under the native splash */
let drawnAt = 0
/** Payments come a page at a time as Home scrolls (lazy-tx-list.tsx's PAGE) */
const ACTIVITY_PAGE = 10
/**
 * How each payment comes in, the first ones and each page after: up from a
 * little below as it fades in, easing out so it settles firmly into place,
 * one after another down the page
 */
const ROW_RISE = 12
const ROW_IN_MS = 520
const ROW_STAGGER_MS = 45
/** The next page starts loading this far before the end is on screen */
const LOAD_AHEAD = 120
/** The layout to draw before Home has been seen with its wallet open: one coin, a few payments */
const FIRST_SHAPE = { coins: 1, rows: 3 }
/** How long the splash waits for a wallet that opens fast: its figures, not placeholders for an instant */
const SPLASH_HOLD = 150
/** A tap made while the wallet opens, done once it's open (the last one, if several). */
let queued: (() => void) | null = null


export default function Home() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const prefs = usePrefs()
  const data = useHomeData()
  const { presence, retry } = useWalletPresence()
  // still opening: Home as it was last time, figures to come
  const opening = presence === 'loading'
  const shape = prefs.homeShape
  const ready = presence === 'ready'
  const whenOpen = (run: () => void) => () => {
    if (ready) run()
    else queued = run
  }
  useEffect(() => {
    if (!ready || !queued) return
    const run = queued
    queued = null
    run()
  }, [ready])
  usePendingHandleClaim()
  const still = useReducedMotion()
  const [entering] = useState(() => !entered)
  const [scrolled, setScrolled] = useState(false)
  const router = useRouter()
  const [backupOpen, setBackupOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [touring, setTouring] = useState(false)
  const [walletsOpen, setWalletsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // the tour starts at the top, so the bar and tiles are where its labels expect
  const scroller = useRef<ScrollView>(null)
  const scrollToTop = useCallback(() => scroller.current?.scrollTo({ y: 0, animated: false }), [])
  // the end of the walk to the tour: Settings, where it lives, lit up for a moment
  const again = useShowAgain()
  useEffect(() => {
    if (!again.settingsButton) return
    const t = setTimeout(() => setShowAgain({ settingsButton: false }), 2700)
    return () => clearTimeout(t)
  }, [again.settingsButton])
  // Sync is on by default: its card only asks when someone turned it off
  const syncOn = useSyncEnabled()
  // the payments, under the first steps: a page now, the next as the end nears
  const { items: recentItems, more, loadMore, loadingMore } = useActivity({ limit: ACTIVITY_PAGE })
  // development builds only: /?backup=<briefing screen> opens the backup there (the simulator can't tap)
  const { backup: devBackup, tour, feedback: devFeedback } = useLocalSearchParams<{ backup?: string; tour?: string; feedback?: string }>()
  useEffect(() => {
    if (__DEV__ && devBackup !== undefined) setBackupOpen(true)
  }, [devBackup])
  // development builds only: /?feedback=1 asks "Enjoying Bitcoin SV Wallet?" now
  useEffect(() => {
    if (__DEV__ && devFeedback !== undefined) requestFeedback('visits', true)
  }, [devFeedback])
  // Settings → Take the tour
  useEffect(() => {
    if (tour) {
      setTouring(true)
      router.setParams({ tour: undefined })
    }
  }, [tour, router])
  useEffect(() => {
    entered = true
  }, [])

  // a new wallet's avatar: the dragon on a colour picked once
  useEffect(() => {
    if (prefs.loaded && !prefs.avatarBg) setPref('avatarBg', randomAvatarBg())
  }, [prefs.loaded, prefs.avatarBg])

  // every coin held, and the total across them (src/state/useAssets)
  const { assets, totalFiat, totalBsv, loading: coinsLoading } = useAssets()
  const bsv = totalBsv
  const usd = totalFiat ?? 0
  const actions: QuickAction[] = [
    { key: 'pay', label: 'Pay', icon: ACTION_ICONS.pay, onPress: whenOpen(() => router.push('/send')) },
    { key: 'receive', label: 'Get paid', icon: ACTION_ICONS.receive, onPress: whenOpen(() => router.push('/receive')) },
    // Vault where this build has it, once Settings' Vault button is on
    ...(isVaultEnabled() && (data.hasWallet || opening) && prefs.showVault ? [{ key: 'vault', label: 'Vault', icon: ACTION_ICONS.vault, onPress: whenOpen(() => router.push('/vault')) }] : [])
  ]

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
    const y = contentOffset.y
    if (y > 4 !== scrolled) setScrolled(y > 4)
    // the end of the list is coming into view: the next page
    if (more && !loadingMore && y + layoutMeasurement.height >= contentSize.height - LOAD_AHEAD) void loadMore()
  }

  // the first time in this session, each part rises in turn (.enter-stagger);
  // drawn while the wallet opened, the bar, total and buttons were in place already
  const rise = (i: number) =>
    entering && !still && !(launch.drewOpening && i < 3)
      ? {
          animationName: enterRise,
          animationDuration: 550,
          animationDelay: Math.min(i, 6) * 90,
          animationTimingFunction: EASE_OUT_QUINT,
          animationFillMode: 'both' as const
        }
      : null

  const recentLoading = opening || recentItems == null
  const recent = recentItems ?? []
  // what Home had last time, for the placeholders until it's read again
  const last = shape ?? FIRST_SHAPE
  const lastRows = last.rows
  const lastCoins = last.coins
  // the total's figure: once the balance is read, and every coin it adds up
  const balanceLoading = opening || data.bsv == null || (coinsLoading && lastCoins > 1)
  const missingCoins = opening || coinsLoading ? Math.max(0, lastCoins - assets.length) : 0

  // how Home looks, for the next launch to draw at once
  const settled = ready && !recentLoading && !coinsLoading
  useEffect(() => {
    if (!settled) return
    // a page at most: rows scrolled into view aren't drawn at the next launch
    const next = { coins: assets.length, rows: Math.min(recent.length, ACTIVITY_PAGE) }
    if (next.coins !== shape?.coins || next.rows !== shape?.rows) setPref('homeShape', next)
  }, [settled, assets.length, recent.length, shape])
  // no wallet any more: nothing to draw next time
  useEffect(() => {
    if (presence === 'none' && shape) setPref('homeShape', null)
  }, [presence, shape])

  // after a few visits, ask how it's going, once Home has settled (and with
  // nothing else up: the tour, a sheet)
  const calm = presence === 'ready' && !touring && !backupOpen && !syncOpen && !walletsOpen && !helpOpen
  useFocusEffect(
    useCallback(() => {
      if (!calm) return
      const t = setTimeout(() => requestFeedback('visits'), 2500)
      return () => clearTimeout(t)
    }, [calm])
  )

  // Home is drawn under the native splash, which goes once the figures are in,
  // or SPLASH_HOLD after it drew, whichever is first: a wallet that opens fast
  // shows its balance straight away; a slower one, its placeholders meanwhile
  const [drawn, setDrawn] = useState(false)
  const figuresIn = !balanceLoading && !recentLoading
  useEffect(() => {
    if (!drawn) return
    if (figuresIn) return hideSplash()
    const t = setTimeout(hideSplash, Math.max(0, drawnAt + SPLASH_HOLD - Date.now()))
    return () => clearTimeout(t)
  }, [drawn, figuresIn])
  const onDrawn = () => {
    drawnAt = Date.now()
    setDrawn(true)
  }

  // onboarding first: the Welcome screens until they're done or skipped (the
  // splash stays up until they draw)
  if (!prefs.loaded || (opening && !prefs.onboarded)) return <View style={[styles.root, { backgroundColor: palette.background }]} />
  if (presence === 'none') {
    // onboarding first; seen it already: straight to making the wallet
    return <Redirect href={prefs.onboarded ? '/welcome?create=1&screen=2' : '/welcome'} />
  }
  if (presence === 'failed') return <OpenFailed onRetry={retry} />
  launch.drewOpening ??= opening

  // a first run: no payments yet (or none last time, while they're read)
  const firstRun = recentLoading ? lastRows === 0 : recent.length === 0
  // backed up: as last known while it opens
  const backedUp = opening ? prefs.phraseBackedUp : data.backedUp
  const steps = [
    // the prototype's "Add a payment method" has no Now meaning (cards and banks are Later)
    { label: 'Back up this wallet', done: backedUp, onPress: whenOpen(() => setBackupOpen(true)) },
    { label: 'Take the tour', done: prefs.tourDone, onPress: () => setTouring(true), again: true }
  ]

  return (
    // the layout's pt-4 above the bar
    // drawn: the native splash goes soon after (see SPLASH_HOLD)
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top + 16 }]} onLayout={onDrawn}>
      <Animated.View style={rise(0)}>
        <TopBar
          avatarBg={(prefs.avatarBg as AvatarBg) ?? 'mint'}
          avatarPortrait={(prefs.avatarPortrait as Portrait) ?? 'dragon'}
          avatarUri={prefs.avatarUri}
          scrolled={scrolled}
          onWallets={whenOpen(() => setWalletsOpen(true))}
          onScan={whenOpen(() => router.push('/sign-in'))}
          onSearch={whenOpen(() => router.push({ pathname: '/activity', params: { search: '1' } }))}
          onHelp={() => setHelpOpen(true)}
          onSettings={whenOpen(() => router.push('/settings'))}
          settingsLit={again.settingsButton}
        />
      </Animated.View>
      <ScrollView
        ref={scroller}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={rise(1)}>
          <BalanceHero bsv={bsv} usd={usd} privacy={prefs.privacy} loading={balanceLoading} onTogglePrivacy={() => setPref('privacy', !prefs.privacy)} />
        </Animated.View>
        <Animated.View style={rise(2)}>
          <QuickActions actions={actions} />
        </Animated.View>
        <Animated.View style={[styles.money, rise(3)]}>
          <View style={styles.assets}>
            {/* BitcoinSV always; other coins once they hold something */}
            {assets.map(a => (
              <AssetRow
                key={a.id}
                asset={a}
                privacy={prefs.privacy}
                loading={a.id === 'bsv' && (opening || data.bsv == null)}
                onPress={whenOpen(() => router.push({ pathname: '/coins/[id]', params: { id: a.id } }))}
              />
            ))}
            {Array.from({ length: missingCoins }, (_, i) => (
              <AssetRowSkeleton key={i} />
            ))}
          </View>
          {/* the few steps to get going, ticked off as they're done (with
              payments or without, as the prototype's: until done or hidden) */}
          {!prefs.setupHidden && <SetupChecklist steps={steps} onHide={() => setPref('setupHidden', true)} />}
          {/* a wallet with history: the same first steps, as small cards */}
          {!firstRun && (
            <View style={styles.smallCards}>
              <SmallCards
                showTour={!prefs.tourDone}
                showSeed={!backedUp}
                showSync={!prefs.syncCardDismissed && syncOn === false}
                onTour={() => setTouring(true)}
                onTourDismiss={() => setPref('tourDone', true)}
                onBackup={whenOpen(() => setBackupOpen(true))}
                onSync={whenOpen(() => setSyncOpen(true))}
                onSyncDismiss={() => setPref('syncCardDismissed', true)}
              />
            </View>
          )}
          {/* shown during the tour too, so it has something to point at */}
          {(!firstRun || touring) && (
            <View style={styles.recentHead}>
              <Pressable ref={tourTarget('activity')} onPress={whenOpen(() => router.push('/activity'))} accessibilityRole="button" style={styles.recentLink}>
                <Text style={[font(600), styles.recentTitle, { color: palette.foreground }]}>Recent activity</Text>
                <ChevronRight size={16} color={palette.mutedForeground} />
              </Pressable>
              <Pressable
                ref={tourTarget('contacts')}
                onPress={whenOpen(() => router.push('/contacts'))}
                accessibilityRole="button"
                style={[styles.contactsPill, { backgroundColor: palette.secondary }]}
              >
                <Users size={14} color={palette.foreground} />
                <Text style={[font(600), styles.pillText, { color: palette.foreground }]}>Contacts</Text>
              </Pressable>
            </View>
          )}
          {/* a new wallet's first steps, under the activity heading while the
              tour shows it; a wallet with history has the small cards above */}
          {firstRun && (
            <HomeCards
              showTour={!prefs.tourDone}
              showSeed={!backedUp}
              showSync={!prefs.syncCardDismissed && syncOn === false}
              onTour={() => setTouring(true)}
              onBackup={whenOpen(() => setBackupOpen(true))}
              onSync={whenOpen(() => setSyncOpen(true))}
              onSyncLater={() => setPref('syncCardDismissed', true)}
            />
          )}
          <View style={styles.recentList}>
            {recentLoading && lastRows > 0 && <TxRowSkeleton count={lastRows} />}
            {/* each comes in, a row at a time, a page at a time (lazy-tx-list.tsx) */}
            {recent.map((tx, i) => (
              <Animated.View
                key={tx.id}
                style={
                  still
                    ? null
                    : enter({ translateY: ROW_RISE, duration: ROW_IN_MS, delay: (i % ACTIVITY_PAGE) * ROW_STAGGER_MS, easing: EASE_OUT_QUINT })
                }
              >
                <TxRow tx={tx} />
              </Animated.View>
            ))}
            {/* the next page on its way */}
            {loadingMore && <TxRowSkeleton count={3} />}
          </View>
        </Animated.View>
      </ScrollView>
      {/* floats over the list, near the bottom, once there's activity to see */}
      {!firstRun && (
        <View pointerEvents="box-none" style={[styles.seeAllWrap, { bottom: Math.max(12, insets.bottom) }]}>
          <Pressable
            onPress={whenOpen(() => router.push('/activity'))}
            accessibilityRole="button"
            style={[styles.seeAll, { backgroundColor: palette.background + 'e6', boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}` }]}
          >
            <Text style={[font(600), styles.pillText14, { color: palette.foreground }]}>See all activity</Text>
            <ChevronRight size={16} color={palette.foreground} />
          </Pressable>
        </View>
      )}
      <HomeTour
        open={touring}
        scrollToTop={scrollToTop}
        onSkip={() => {
          setTouring(false)
          setPref('tourDone', true)
          // and where to take it again: Settings, its row lit up (as after the video)
          setShowAgain({ tourRow: true })
          router.push('/settings')
        }}
        onLearnMore={() => {
          setTouring(false)
          setTourVideo('full')
        }}
      />
      <Wallets open={walletsOpen} onOpenChange={setWalletsOpen} />
      <BackupNudge backedUp={backedUp} onBackUp={() => setBackupOpen(true)} />
      <HelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
      <SyncSheet open={syncOpen} onOpenChange={setSyncOpen} />
      <BackupSheet open={backupOpen} onOpenChange={setBackupOpen} devBrief={__DEV__ && devBackup ? Number(devBackup) : undefined} />
    </View>
  )
}

/** A wallet is stored on this phone but couldn't be opened (e.g. biometrics were refused). */
function OpenFailed({ onRetry }: { onRetry: () => void }) {
  const palette = usePalette()
  return (
    <View style={[styles.root, styles.failed, { backgroundColor: palette.background }]} onLayout={hideSplash}>
      <Text style={[font(700), { fontSize: 20, lineHeight: 28, color: palette.foreground }]}>Couldn’t open your wallet</Text>
      <BalancedText style={[font(400), { fontSize: 15, lineHeight: 22, textAlign: 'center', color: palette.mutedForeground }]}>
        It’s still on this phone. Unlock it to carry on.
      </BalancedText>
      <GlassButton label="Try again" onPress={onRetry} />
    </View>
  )
}

const styles = StyleSheet.create({
  failed: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  root: { flex: 1 },
  // the page's gap-6 between the bar and the hero
  content: { paddingHorizontal: 16, gap: 24, paddingTop: 24 },
  money: { gap: 12 },
  // mt-1 over the gap
  smallCards: { marginTop: 4 },
  recentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12 },
  recentLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  recentTitle: { fontSize: 16, lineHeight: 24 },
  contactsPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  pillText: { fontSize: 13, lineHeight: 18 },
  pillText14: { fontSize: 14, lineHeight: 20 },
  recentList: { marginHorizontal: -8, marginTop: -8, paddingBottom: 56 },
  seeAllWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  assets: { marginHorizontal: -8 }
})
