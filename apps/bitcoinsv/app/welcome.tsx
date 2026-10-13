// Onboarding: the prototype's app/welcome/page.tsx. Three Why screens for
// people who don't care about crypto but don't want to be left behind: you
// don't need to get it, it saves you money, it doesn't want your data.
import React, { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft, CreditCard } from 'lucide-react-native'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../src/ui/Toast'
import { font, useIsDark, usePalette } from '../src/theme'
import { setPref } from '../src/state/prefs'
import { BsvMark } from '../src/ui/BsvMark'
import { GlassButton } from '../src/ui/GlassButton'
import { barFill, enter, useReducedMotion } from '../src/ui/motion'
import { BalancedText } from '../src/ui/BalancedText'
import { cubicBezier } from 'react-native-reanimated'
import { EasyArt } from '../src/art/EasyArt'
import { EggsArt } from '../src/art/EggsArt'
import { NoDataArt } from '../src/art/NoDataArt'
import { useFirstWallet } from '../src/state/useFirstWallet'
import { CreateWalletSheet } from '../src/onboarding/CreateWalletSheet'
import { HandleCheckout } from '../src/onboarding/HandleCheckout'
import { ImportWalletSheet } from '../src/restore/ImportWalletSheet'
import type { AvatarChoice } from '../src/onboarding/AvatarPicker'
import { generatedName, type GeneratedHandle } from '../src/handles/generator'

const SCREENS = [
  { title: 'No crypto skills needed', body: 'It works like any payment app. Tap, pay, done.' },
  { title: 'More bang for your buck', body: 'Card companies take about 3% + 30¢ of every purchase. Shops add it to your prices.' },
  {
    title: "We don't want your data",
    body: 'No email, phone number or ID to sign up. Nothing to leak or sell. You own your money, and only you can open your wallet.'
  }
] as const

const BAR_EASE = cubicBezier(0.22, 1, 0.36, 1)
/** transition-all's default curve, for the screen dots. */
const DOT_EASE = cubicBezier(0.4, 0, 0.2, 1)

export default function Welcome() {
  const palette = usePalette()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  // ?screen=1 opens a given screen (deep links, and stepping through on a simulator)
  const params = useLocalSearchParams<{ screen?: string; create?: string }>()
  const [screen, setScreen] = useState(() => Math.min(SCREENS.length - 1, Math.max(0, Number(params.screen) || 0)))
  useEffect(() => {
    if (params.screen != null) setScreen(Math.min(SCREENS.length - 1, Math.max(0, Number(params.screen) || 0)))
  }, [params.screen])
  // the eggs screen loops: pay by card (an egg goes), pay with BitcoinSV (it comes back, golden)
  const [phase, setPhase] = useState<'card' | 'bsv'>('card')
  useEffect(() => {
    if (screen !== 1) return
    const t = setInterval(() => setPhase(p => (p === 'card' ? 'bsv' : 'card')), 2800)
    return () => clearInterval(t)
  }, [screen])

  // the first wallet: made at the end of the Why screens, with its handle
  const { walletBuilt } = useWallet()
  const first = useFirstWallet()
  const [createOpen, setCreateOpen] = useState(params.create === '1')
  // "Used Bitcoin SV Wallet before? Sign in": bring a wallet back
  const [importing, setImporting] = useState(false)
  const [checkout, setCheckout] = useState<{ handle: string; monthly: number; yearly: number; avatar: AvatarChoice; generated: GeneratedHandle } | null>(null)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    if (params.create === '1') setCreateOpen(true)
  }, [params.create])

  const last = screen === SCREENS.length - 1
  const finish = () => {
    setPref('onboarded', true)
    if (walletBuilt) router.replace('/')
    else setCreateOpen(true)
  }

  const createWallet = async (handle: string, displayName: string, avatar: AvatarChoice) => {
    setCreating(true)
    setPref('avatarPortrait', avatar.portrait)
    setPref('avatarBg', avatar.bg)
    setPref('avatarUri', avatar.uri)
    const outcome = await first.create(handle, displayName)
    if (outcome.kind === 'exists') {
      // a wallet was already here: nothing new was made
      router.replace('/')
    } else if (outcome.kind !== 'created') {
      setCreating(false)
      showToast(outcome.kind === 'refused' ? 'This phone wouldn’t store the wallet’s key. Try again.' : 'Couldn’t create the wallet. Try again.', { type: 'error' })
    }
    // created: the handle is claimed next, then Home (below)
  }

  // the wallet is made and its handle settled: say how it went, then Home
  useEffect(() => {
    const c = first.claimed
    if (!c) return
    if (c.kind === 'pending') showToast(`Your wallet is ready. @${c.handle} isn’t confirmed yet (${c.reason}); it’ll be tried again.`, { type: 'info' })
    if (c.kind === 'refused') showToast(`Your wallet is ready, but @${c.handle} couldn’t be claimed: ${c.reason}.`, { type: 'error' })
    setCreateOpen(false)
    setCheckout(null)
    router.replace('/')
  }, [first.claimed, router])
  // fade and rise in, one after another
  const rise = (i: number, base = 150) => (still ? null : enter({ translateY: 8, duration: 500, delay: base + i * 110 }))
  const { title, body } = SCREENS[screen]

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
      {/* back on the left (after the first screen), the name centred, Skip right */}
      <View style={styles.header}>
        <View style={styles.side}>
          {screen > 0 && (
            <Pressable
              onPress={() => setScreen(s => s - 1)}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={[styles.back, { backgroundColor: palette.secondary + 'cc' }]}
            >
              <ArrowLeft size={16} color={palette.foreground} />
            </Pressable>
          )}
        </View>
        <Text accessibilityLabel="Bitcoin SV Wallet" style={[font(700), styles.brand, { color: palette.foreground }]}>
          Bitcoin SV <Text style={[font(600), { opacity: 0.6 }]}>Wallet</Text>
        </Text>
        <View style={[styles.side, { alignItems: 'flex-end' }]}>
          <Pressable onPress={finish} accessibilityRole="button" hitSlop={10}>
            <Text style={[font(500), styles.skip, { color: palette.mutedForeground }]}>Skip</Text>
          </Pressable>
        </View>
      </View>

      <View key={screen} style={styles.body}>
        <Animated.View style={[styles.art, still ? null : enter({ scale: 0.95, duration: 500 })]}>
          {screen === 0 ? <EasyArt /> : screen === 1 ? <EggsArt phase={phase} /> : <NoDataArt />}
        </Animated.View>
        <Animated.View style={[styles.balanced, rise(0)]}>
          <BalancedText accessibilityRole="header" style={[font(700), styles.title, { color: palette.foreground }]}>
            {title}
          </BalancedText>
        </Animated.View>
        <Animated.View style={[styles.balanced, rise(1)]}>
          <BalancedText style={[font(400), styles.text, { color: palette.mutedForeground }]}>{body}</BalancedText>
        </Animated.View>
        {screen === 1 && <FeeBreakdown phase={phase} rise={rise} />}
      </View>

      <ImportWalletSheet
        open={importing}
        onOpenChange={setImporting}
        onDone={() => {
          setPref('onboarded', true)
          router.replace('/')
        }}
      />
      <CreateWalletSheet
        open={createOpen && !checkout}
        onOpenChange={o => !creating && setCreateOpen(o)}
        domain={first.domain}
        checkAvailability={first.checkAvailability}
        busy={creating}
        onCreate={c => void createWallet(c.handle, c.displayName, c.avatar)}
        onCustom={c => setCheckout(c)}
      />
      {checkout && (
        <HandleCheckout
          open={createOpen && !!checkout}
          onOpenChange={o => !o && setCheckout(null)}
          handle={checkout.handle}
          fallback={checkout.generated.handle}
          monthly={checkout.monthly}
          yearly={checkout.yearly}
          onUseFree={() => {
            const c = checkout
            setCheckout(null)
            void createWallet(c.generated.handle, generatedName(c.generated), c.avatar)
          }}
        />
      )}

      <View style={styles.footer}>
        <View style={styles.dots}>
          {SCREENS.map((_, i) => (
            <Pressable key={i} onPress={() => setScreen(i)} accessibilityRole="button" accessibilityLabel={`Screen ${i + 1}`} hitSlop={8}>
              <Animated.View
                style={{
                  height: 8,
                  borderRadius: 4,
                  width: i === screen ? 24 : 8,
                  backgroundColor: i === screen ? palette.ink : palette.border,
                  transitionProperty: ['width', 'backgroundColor'],
                  transitionDuration: 150,
                  transitionTimingFunction: DOT_EASE
                }}
              />
            </Pressable>
          ))}
        </View>
        <GlassButton size="lg" label={last ? 'Got it' : 'Continue'} onPress={() => (last ? finish() : setScreen(s => s + 1))} />
        {/* back on a new phone: sign in with a backup */}
        <Pressable onPress={() => setImporting(true)} accessibilityRole="button" style={styles.signIn}>
          <Text style={[font(500), styles.signInText, { color: palette.mutedForeground }]}>
            Used Bitcoin SV Wallet before?{' '}
            <Text style={[font(600), { color: palette.foreground, textDecorationLine: 'underline' }]}>Sign in</Text>
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

/**
 * The same $6 box of eggs paid two ways: two bars that grow in, the card one
 * nearly full width, the BitcoinSV one barely there, and what that fee is in eggs.
 */
function FeeBreakdown({ phase, rise }: { phase: 'card' | 'bsv'; rise: (i: number, base?: number) => object | null }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const rows = [
    { label: 'Card', fee: '47¢', width: '100%' as const, color: palette.destructive, tint: palette.destructive + '1a' },
    { label: 'Bitcoin SV', fee: 'under 1¢', width: '2.5%' as const, color: palette.positive, tint: palette.positive + '1f' }
  ]
  return (
    <Animated.View
      style={[
        styles.fees,
        {
          backgroundColor: palette.card + 'cc',
          boxShadow: `0 0 0 1px ${palette.border}, ${dark ? '0 2px 26px -2px rgba(255,255,255,0.10)' : '0 2px 22px -2px rgba(20,24,40,0.16)'}`
        },
        rise(2)
      ]}
    >
      <Text style={[font(600), styles.feesTitle, { color: palette.mutedForeground }]}>FEES ON A $6 BOX OF EGGS</Text>
      <View style={styles.feeRows}>
        {rows.map((r, i) => {
          const lit = (i === 0) === (phase === 'card')
          return (
            // the row matching the carton lights up; the other steps back
            <Animated.View
              key={r.label}
              style={[
                styles.feeRow,
                {
                  backgroundColor: lit ? r.tint : 'transparent',
                  opacity: lit ? 1 : 0.45,
                  transitionProperty: ['backgroundColor', 'opacity'],
                  transitionDuration: 500
                }
              ]}
            >
              <View style={styles.feeTop}>
                <View style={styles.feeLabel}>
                  {/* ink badge: black with a white icon, white with black in dark mode */}
                  {i === 0 ? (
                    <View style={[styles.badge, { backgroundColor: palette.ink }]}>
                      <CreditCard size={16} color={palette.inkForeground} />
                    </View>
                  ) : (
                    <BsvMark size={28} />
                  )}
                  <Text style={[font(600), styles.feeLabelText, { color: palette.foreground }]}>{r.label}</Text>
                </View>
                <Text style={[font(800), styles.fee, { color: r.color }]}>{r.fee}</Text>
              </View>
              {/* the bar grows in, card first */}
              <View style={[styles.track, { backgroundColor: palette.secondary }]}>
                <Animated.View
                  style={[
                    { height: '100%', borderRadius: 4, width: r.width, minWidth: 6, backgroundColor: r.color, transformOrigin: 'left' },
                    still
                      ? null
                      : { animationName: barFill, animationDuration: 900, animationDelay: 700 + i * 500, animationTimingFunction: BAR_EASE, animationFillMode: 'both' }
                  ]}
                />
              </View>
            </Animated.View>
          )
        })}
      </View>
      <Animated.View style={rise(0, 1900)}>
        <BalancedText style={[font(600), styles.half, { color: palette.foreground }]}>That&apos;s half an egg, every time you pay by card.</BalancedText>
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, overflow: 'hidden' },
  header: { height: 36, flexDirection: 'row', alignItems: 'center', zIndex: 10 },
  side: { flex: 1 },
  back: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 20, lineHeight: 22, letterSpacing: -0.5 },
  skip: { fontSize: 14, lineHeight: 20 },
  body: { flex: 1, alignItems: 'center', paddingTop: 16 },
  art: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { maxWidth: 384, textAlign: 'center', fontSize: 30, lineHeight: 37.5, letterSpacing: -0.75 },
  text: { maxWidth: 384, marginTop: 12, textAlign: 'center', fontSize: 15, lineHeight: 24.4 },
  // what the title and text animate in: as wide as the body, the text centred in it
  balanced: { alignSelf: 'stretch', alignItems: 'center' },
  footer: { width: '100%', maxWidth: 384, alignSelf: 'center', gap: 24, paddingTop: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  signIn: { marginTop: -12, alignItems: 'center' },
  signInText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  fees: { marginTop: 20, width: '100%', maxWidth: 384, borderRadius: 16, padding: 16 },
  feesTitle: { textAlign: 'center', fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },
  feeRows: { gap: 16, paddingTop: 12 },
  feeRow: { marginHorizontal: -8, gap: 6, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  feeTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  feeLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  feeLabelText: { fontSize: 14, lineHeight: 20 },
  fee: { fontSize: 24, lineHeight: 32, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  half: { paddingTop: 16, textAlign: 'center', fontSize: 14, lineHeight: 20 }
})
