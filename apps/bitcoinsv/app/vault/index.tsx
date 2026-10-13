// Vault, as the prototype's app/(wallet)/vault/page.tsx: set one up, or see
// what's in it and move money in and out. Development and preview builds only
// (isVaultEnabled; never production, decision 14).
//
// Everything that touches the keys is the shared core's, unchanged: the
// enrolment wizard (EnrollWizard, at /vault/setup), key management and
// recovery (VaultScreen, at /vault/manage), the transfers themselves (in a
// sheet here, the prototype's, src/vault/VaultMoveSheet.tsx) and the touch/PIN ceremony
// sheet mounted at the root. So unlike the prototype it's two or more
// YubiKeys with a PIN, BitcoinSV only, and money out goes back to this
// wallet's spending. Its last three moves show under what's in it.
import React, { useCallback, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Redirect, useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowDownToLine, ArrowUpFromLine, KeyRound, ShieldCheck, Vault as VaultIcon } from 'lucide-react-native'
import { isVaultEnabled, useVault } from '@bsv/expo-wallet-toolbox'
import { vaultStore } from '@bsv/expo-wallet-toolbox/core/services/vault/vaultStore'
import { useVaultBalance } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../../src/ui/Toast'
import { font, usePalette } from '../../src/theme'
import { PageHeader } from '../../src/ui/PageHeader'
import { ViewInfo } from '../../src/ui/ViewInfo'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { GlassButton } from '../../src/ui/GlassButton'
import { BsvMark } from '../../src/ui/BsvMark'
import { HeroMoney, Money } from '../../src/ui/Money'
import { BalancedText } from '../../src/ui/BalancedText'
import { HardwareKeyArt } from '../../src/vault/HardwareKeyArt'
import { usePrefs } from '../../src/state/prefs'
import { useHomeData } from '../../src/state/useHomeData'
import { useDisplayCurrency } from '../../src/state/displayCurrency'
import { DevKeys } from '../../src/vault/DevKeys'
import { VaultMoveSheet, type MoveDirection } from '../../src/vault/VaultMoveSheet'
import { TxRow } from '../../src/activity/TxRow'
import { useActivity } from '../../src/activity/useActivity'

const SATS_PER_BSV = 100_000_000

const ABOUT_KEY = [
  {
    h: 'A key for your money',
    p: 'A YubiKey is a small device made by Yubico, about the size of a house key. It plugs into USB-C or taps against your phone (NFC). There’s no battery and nothing to charge.'
  },
  {
    h: 'How it opens your vault',
    p: 'Hold it to the back of your phone or plug it in, enter its PIN, then touch the gold contact when it blinks. That touch is the approval: without the key in your hand, the vault stays shut.'
  },
  {
    h: 'Why it’s safer',
    p: 'The secret inside can’t be copied, phished or read by an app. Even someone with your phone and passcode can’t open the vault without the key.'
  },
  {
    h: 'Which one to get',
    p: 'Any YubiKey 5 with NFC or USB-C works. You set up two, so losing one never locks you out: keep the spare somewhere safe.'
  }
]

export default function VaultPage() {
  const { hasVaultMeta } = useVault()
  // read again on coming back from set-up: the core's context re-reads on a
  // ceremony phase, and enrolment's last write can land after its last phase
  const [enrolled, setEnrolled] = useState<boolean | null>(null)
  useFocusEffect(
    useCallback(() => {
      let live = true
      vaultStore
        .isEnrolled()
        .then(e => live && setEnrolled(e))
        .catch(() => live && setEnrolled(false))
      return () => {
        live = false
      }
    }, [hasVaultMeta])
  )
  if (!isVaultEnabled()) return <Redirect href="/" />
  if (enrolled === null) return null
  return enrolled ? <VaultOverview /> : <VaultSetup />
}

function Shell({ info, children }: { info: string; children: React.ReactNode }) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.headerPad}>
        <PageHeader
          title="Vault"
          onBack={() => router.back()}
          action={<ViewInfo about="Vault" text={info} />}
        />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  )
}

function VaultSetup() {
  const palette = usePalette()
  const router = useRouter()
  const data = useHomeData()
  const [aboutKey, setAboutKey] = useState(false)
  return (
    <Shell info="Your vault keeps savings behind your YubiKeys. Nothing moves out without one of them held to your phone and a touch on its contact.">
      <View style={styles.setup}>
        <HardwareKeyArt />
        <View style={styles.setupText}>
          <Text style={[font(700), styles.h1, { color: palette.foreground }]}>Connect your YubiKeys</Text>
          <BalancedText style={[font(400), styles.body, styles.center, { color: palette.mutedForeground }]}>
            Your vault opens with a YubiKey. You set up two, one to use and a spare, so keep them somewhere safe.
          </BalancedText>
          <Pressable onPress={() => setAboutKey(true)} accessibilityRole="button" hitSlop={8}>
            <Text style={[font(600), styles.body, { color: palette.foreground }]}>What’s a YubiKey?</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.footer}>
        <GlassButton
          size="lg"
          label="Set up your vault"
          icon={<KeyRound size={18} color={palette.goldForeground} />}
          onPress={() => {
            // only the recovery phrase can bring a vault back (the keys carry no seed): backed up first
            if (!data.backedUp) {
              showToast('Back up this wallet first. Its recovery phrase is what brings a vault back.', { type: 'info' })
              router.push('/settings?backup=1')
            } else router.push('/vault/setup')
          }}
        />
        <Pressable onPress={() => router.push('/vault/manage')} accessibilityRole="button" style={styles.manage}>
          <Text style={[font(600), styles.body, { color: palette.foreground }]}>Restore a vault you already have</Text>
        </Pressable>
        {__DEV__ && <DevKeys />}
      </View>

      <BottomSheet open={aboutKey} onOpenChange={setAboutKey} title="What’s a YubiKey?" description="A small hardware key that proves it’s really you.">
        <View style={styles.aboutKey}>
          {ABOUT_KEY.map(s => (
            <View key={s.h}>
              <Text style={[font(600), styles.body, { color: palette.foreground }]}>{s.h}</Text>
              <Text style={[font(400), styles.body, { color: palette.mutedForeground, paddingTop: 4 }]}>{s.p}</Text>
            </View>
          ))}
          <Text
            accessibilityRole="link"
            onPress={() => void Linking.openURL('https://www.yubico.com/products/')}
            style={[font(600), styles.body, { color: palette.foreground, textDecorationLine: 'underline' }]}
          >
            See YubiKeys at yubico.com
          </Text>
        </View>
      </BottomSheet>
    </Shell>
  )
}

function VaultOverview() {
  const palette = usePalette()
  const router = useRouter()
  const prefs = usePrefs()
  const { balance } = useVaultBalance()
  const { fromSats } = useDisplayCurrency()
  const sats = balance ?? 0
  // moving money: one sheet, in or out (the prototype's VaultMoveSheet)
  const [move, setMove] = useState<MoveDirection | null>(null)
  const [moveDir, setMoveDir] = useState<MoveDirection>('in')
  const openMove = (d: MoveDirection) => {
    setMoveDir(d)
    setMove(d)
  }
  // the last three moves between spending and the vault (the core labels them)
  const { items } = useActivity({ limit: 50 })
  const moves = (items ?? [])
    .filter(tx => tx.labels.some(l => l === 'vault-deposit' || l === 'vault-withdraw'))
    .slice(0, 3)
    .map(tx => ({ ...tx, title: tx.labels.includes('vault-deposit') ? 'Moved to Vault' : 'Moved to spending' }))
  return (
    <Shell info="Savings kept apart from everyday spending. Money moves in freely; taking money out needs one of your YubiKeys.">
      <View style={styles.hero}>
        <View style={styles.eyebrow}>
          <VaultIcon size={14} color={palette.mutedForeground} />
          <Text style={[font(600), styles.eyebrowText, { color: palette.mutedForeground }]}>IN YOUR VAULT</Text>
        </View>
        <View accessible accessibilityLabel={`In your vault, ${prefs.privacy ? 'hidden' : `${sats / SATS_PER_BSV} BSV`}`}>
          <HeroMoney amount={fromSats(sats) ?? 0} unit="usd" privacy={prefs.privacy} style={{ ...font(800), fontSize: 48, lineHeight: 48, letterSpacing: -1.2, color: palette.foreground }} />
        </View>
        <View style={styles.protected}>
          <ShieldCheck size={16} color={palette.positive} />
          <Text style={[font(400), styles.body, { color: palette.mutedForeground }]}>Protected by your YubiKeys</Text>
        </View>
      </View>

      {/* what's inside: BitcoinSV only */}
      <View style={styles.asset}>
        <BsvMark size={36} />
        <Text style={[font(500), styles.body, styles.flex, { color: palette.foreground }]}>BitcoinSV</Text>
        <Money amount={sats / SATS_PER_BSV} unit="bsv" privacy={prefs.privacy} style={[font(600), styles.body, { color: palette.foreground }]} />
      </View>

      {moves.length > 0 && (
        <View>
          <Text style={[font(600), styles.eyebrowText, styles.movesHeading, { color: palette.mutedForeground }]}>RECENT MOVES</Text>
          <View style={styles.moves}>
            {moves.map(tx => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </View>
        </View>
      )}

      <Pressable onPress={() => router.push('/vault/manage')} accessibilityRole="button" style={styles.manage}>
        <KeyRound size={16} color={palette.foreground} />
        <Text style={[font(600), styles.body, { color: palette.foreground }]}>Keys and recovery</Text>
      </Pressable>

      <View style={styles.footer}>
        <GlassButton size="lg" label="Move money in" icon={<ArrowDownToLine size={18} color={palette.goldForeground} />} onPress={() => openMove('in')} />
        <GlassButton
          size="lg"
          variant="outline"
          label="Take money out"
          icon={<ArrowUpFromLine size={18} color={palette.foreground} />}
          onPress={() => openMove('out')}
        />
        {__DEV__ && <DevKeys />}
      </View>
      <VaultMoveSheet open={move !== null} onOpenChange={o => !o && setMove(null)} direction={moveDir} />
    </Shell>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // the other pages' px-4 around their header
  headerPad: { paddingHorizontal: 16 },
  content: { flexGrow: 1, paddingHorizontal: 16, gap: 24, paddingTop: 8 },
  setup: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 24 },
  setupText: { alignItems: 'center', gap: 8, minHeight: 128 },
  h1: { fontSize: 24, lineHeight: 32, letterSpacing: -0.5, textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  center: { textAlign: 'center', maxWidth: 320 },
  footer: { marginTop: 'auto', gap: 8 },
  aboutKey: { gap: 20 },
  hero: { alignItems: 'center', gap: 4, paddingTop: 8 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // text-[11px] tracking-widest
  movesHeading: { fontSize: 11, lineHeight: 16, letterSpacing: 1.1, paddingBottom: 4, paddingLeft: 4 },
  moves: { marginHorizontal: -8 },
  // text-xs tracking-widest (0.1em)
  eyebrowText: { fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },
  protected: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8 },
  asset: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 10 },
  flex: { flex: 1 },
  manage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 }
})
