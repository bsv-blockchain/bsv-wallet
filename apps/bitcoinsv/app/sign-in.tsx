// Scan to sign in (the prototype's app/(wallet)/scan/page.tsx), on the shared
// core's wallet pairing (src/signin): scan the code a website shows, see who's
// asking and what they'll get, and sign in. The site then talks to this
// wallet over an encrypted relay, asking for what it needs (who you are,
// signatures), each under the wallet's own prompts; nothing is paid without
// asking, unless you've set an amount that may be (disclosed here first).
// Settings → Sign-ins lists the sites and signs out of them.
import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BadgeCheck, Check, CircleAlert, Globe, LockKeyhole, ScanLine, UserRound, type LucideIcon } from 'lucide-react-native'
import { AUTO_APPROVE_DAILY_CAP_SATS, useWallet, useWalletConnection } from '@bsv/expo-wallet-toolbox'
import { QRScanner } from '@bsv/expo-wallet-toolbox/ui'
import { font, usePalette } from '../src/theme'
import { BottomSheet } from '../src/ui/BottomSheet'
import { GlassButton } from '../src/ui/GlassButton'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { BalancedText } from '../src/ui/BalancedText'
import { Avatar, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { enter, popIn } from '../src/ui/motion'
import { bsvFigure } from '../src/activity/format'
import { useWalletList } from '../src/home/useWalletList'
import { readSignInCode, type SignInCode } from '../src/signin/code'
import { approveSignIn, autoApproveThreshold } from '../src/signin/signIn'

/** "What is Sign in with Web3?", the prototype's words. */
const ABOUT = [
  {
    h: 'No password, just your wallet',
    p: 'Instead of making yet another account with a password, you prove who you are with your wallet. It’s the same idea as “Sign in with Google”, but no big company sits in the middle. You own the key.'
  },
  {
    h: 'How it works',
    p: 'The website shows a QR code with a one-time puzzle in it. Your wallet solves it by signing it with your identity key, a secret that never leaves your phone. The site checks the signature against your public key. If it matches, it knows it’s you.'
  },
  {
    h: 'So what’s BRC-100?',
    p: 'It’s the open rulebook that lets any BSV app talk to any BSV wallet the same way: asking who you are, asking for a signature, and only getting what you say yes to. Think of it like USB-C, but for wallets and apps.'
  },
  {
    h: 'What the site gets, and what it doesn’t',
    p: 'It gets your public identity and whatever you choose to share. It never gets your recovery phrase, and it can only spend what you allow: the sign-in screen says how much, if anything, it may without asking.'
  },
  {
    h: 'Why it’s safer',
    p: 'There’s no password to leak, guess or reuse. Fake sites have nothing to steal, and you see exactly who’s asking every single time. Plus, one identity works across every app that supports it.'
  }
]

type Stage = 'intro' | 'camera' | 'review' | 'signing' | 'done' | 'failed'

export default function SignIn() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  // a code scanned elsewhere (Scan & pay) arrives as ?code=
  const { code: handed } = useLocalSearchParams<{ code?: string }>()
  const { managers } = useWallet()
  const { status, errorMsg, connect, disconnect, startNavTimer, cancelNavTimer } = useWalletConnection()
  const me = useWalletList().find(w => w.active)
  const [stage, setStage] = useState<Stage>('intro')
  const [code, setCode] = useState<SignInCode | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(0)
  const [aboutOpen, setAboutOpen] = useState(false)

  const read = (raw: string) => {
    const r = readSignInCode(raw)
    if ('error' in r) {
      setProblem(r.error)
      setStage('failed')
      return
    }
    setCode(r.code)
    setStage('review')
  }
  // each code handed in once; a new one (a second sign-in link opened while
  // this screen is up) is read too, never mid-sign-in
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (handed && handed !== seeded.current && stage !== 'signing') {
      seeded.current = handed
      read(handed)
    }
  }, [handed, stage])
  useEffect(() => {
    void autoApproveThreshold().then(setThreshold)
  }, [])

  // the session's outcome, once signing: only once this attempt has started
  // connecting, never a status left from before it
  const sawConnecting = useRef(false)
  useEffect(() => {
    if (stage !== 'signing') return
    if (status === 'connecting') sawConnecting.current = true
    if (!sawConnecting.current) return
    if (status === 'connected') setStage('done')
    else if (status === 'error' || status === 'disconnected') {
      setProblem(errorMsg ?? 'The website didn’t answer. Try a fresh code.')
      setStage('failed')
    }
  }, [stage, status, errorMsg])

  // as the core's pairing screen: a live session gets its timer once you leave
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  useEffect(() => {
    cancelNavTimer()
    return () => {
      if (statusRef.current === 'connected') startNavTimer()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async () => {
    if (!code || !managers.permissionsManager) return
    // a session still open from before (another site): closed first, so what
    // follows is this one's
    if (status !== 'idle') disconnect()
    sawConnecting.current = false
    setStage('signing')
    try {
      await approveSignIn(managers.permissionsManager, code, connect)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Signing in didn’t work.')
      setStage('failed')
    }
  }
  const again = () => {
    if (status !== 'connected') disconnect()
    setCode(null)
    setProblem(null)
    setStage('camera')
  }

  if (stage === 'camera')
    return <QRScanner onScan={read} onClose={() => setStage('intro')} hintText="Point at the sign-in code on the website" />

  // ── signed in ──
  if (stage === 'done' && code) {
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Sign in" onBack={() => router.back()} />
        </View>
        <View style={styles.done}>
          <Animated.View style={[styles.doneBadge, { backgroundColor: palette.positive }, { animationName: popIn, animationDuration: 300, animationFillMode: 'both' }]}>
            <Check size={30} color="#ffffff" strokeWidth={3} />
          </Animated.View>
          <BalancedText style={[font(700), styles.title, { color: palette.foreground }]}>Signed in to {code.domain}</BalancedText>
          <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            You’re in as <Text style={[font(600), { color: palette.foreground }]}>{me?.name ?? 'you'}</Text>.{'\n'}You can go back to the website now.
          </Text>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <GlassButton size="lg" label="Done" onPress={() => router.back()} />
          <GlassButton size="lg" variant="outline" label="Scan another code" onPress={again} />
        </View>
      </View>
    )
  }

  // ── it didn't work ──
  if (stage === 'failed') {
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Sign in" onBack={() => router.back()} />
        </View>
        <View style={styles.done}>
          <CircleAlert size={48} color={palette.destructive} strokeWidth={1.6} />
          <Text style={[font(700), styles.title, { color: palette.foreground }]}>Not signed in</Text>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>{problem}</BalancedText>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <GlassButton size="lg" label="Scan again" icon={<ScanLine size={18} color={palette.goldForeground} />} onPress={again} />
        </View>
      </View>
    )
  }

  // ── who's asking ──
  if ((stage === 'review' || stage === 'signing') && code) {
    const signing = stage === 'signing'
    const shares: { Icon: LucideIcon; text: string }[] = [
      { Icon: UserRound, text: 'Your public identity, and only what you choose to share' },
      { Icon: BadgeCheck, text: 'Proof it’s really you, signed by your wallet' },
      {
        Icon: LockKeyhole,
        text:
          threshold > 0
            ? `It can spend up to ${bsvFigure(threshold)} BSV a time (${bsvFigure(AUTO_APPROVE_DAILY_CAP_SATS)} a day) without asking; more always asks you`
            : 'No payments without asking you first'
      }
    ]
    return (
      <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <View style={styles.pad}>
          <PageHeader title="Sign in" onBack={signing ? () => {} : () => setStage('intro')} />
        </View>
        <ScrollView contentContainerStyle={styles.review}>
          <Animated.View style={[styles.site, enter({ opacity: 0, translateY: 6, duration: 300 })]}>
            <View style={[styles.siteIcon, { backgroundColor: palette.secondary }]}>
              <Globe size={30} color={palette.foreground} strokeWidth={1.6} />
            </View>
            <BalancedText style={[font(700), styles.title, { color: palette.foreground }]}>{code.domain} wants you to sign in</BalancedText>
            {/* the whole origin, its end kept in view: the part that says whose site it is */}
            <Text numberOfLines={1} ellipsizeMode="middle" style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              {code.origin}
            </Text>
          </Animated.View>

          <View>
            <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>SIGNING IN AS</Text>
            <View style={styles.me}>
              <Avatar
                bg={(me?.look?.avatarBg as AvatarBg) ?? 'mint'}
                portrait={(me?.look?.avatarPortrait as Portrait) ?? 'dragon'}
                uri={me?.look?.avatarUri ?? undefined}
                size={40}
              />
              <View style={styles.flex}>
                <Text style={[font(600), styles.small, { color: palette.foreground }]}>{me?.name ?? 'This wallet'}</Text>
                {me?.handle ? <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{me.handle}</Text> : null}
              </View>
            </View>
          </View>

          <View>
            <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>{code.domain.toUpperCase()} WILL GET</Text>
            <View style={styles.shares}>
              {shares.map(({ Icon, text }) => (
                <View key={text} style={styles.share}>
                  <View style={[styles.shareIcon, { borderColor: palette.foreground + '33' }]}>
                    <Icon size={16} color={palette.foreground} />
                  </View>
                  <Text style={[font(400), styles.small, styles.flex, { color: palette.foreground }]}>{text}</Text>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <GlassButton
            size="lg"
            label={signing ? 'Signing…' : 'Sign in'}
            icon={signing ? <ActivityIndicator size="small" color={palette.goldForeground} /> : undefined}
            disabled={signing}
            onPress={() => void signIn()}
          />
          <Pressable onPress={() => setStage('intro')} disabled={signing} accessibilityRole="button" style={styles.cancel}>
            <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // ── scan ──
  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader
          title="Scan to sign in"
          action={
            <ViewInfo about="Scan to sign in" text="Signing in to a website? Scan the QR code it shows and your wallet proves it’s you. No password, and no access to your money." />
          }
        />
      </View>
      <View style={styles.body}>
        <View style={[styles.viewfinder, { borderColor: palette.border, backgroundColor: palette.card }]}>
          <ScanLine size={56} color={palette.mutedForeground} strokeWidth={1.4} />
        </View>
        <BalancedText style={[font(700), styles.bigTitle, { color: palette.foreground }]}>Scan a website’s sign-in code</BalancedText>
        <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
          Websites that work with Bitcoin SV wallets show a code to sign in with. No password needed.
        </BalancedText>
        <Pressable onPress={() => setAboutOpen(true)} accessibilityRole="button" hitSlop={8}>
          <Text style={[font(600), styles.small, { color: palette.foreground, textDecorationLine: 'underline' }]}>What is Sign in with Web3?</Text>
        </Pressable>
      </View>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <GlassButton size="lg" label="Scan a code" icon={<ScanLine size={18} color={palette.goldForeground} />} onPress={() => setStage('camera')} />
      </View>
      <BottomSheet open={aboutOpen} onOpenChange={setAboutOpen} title="Sign in with Web3" description="Like “Sign in with Google”, except you own the key.">
        <View style={styles.about}>
          {ABOUT.map(a => (
            <View key={a.h} style={styles.aboutItem}>
              <Text style={[font(600), styles.small, { color: palette.foreground }]}>{a.h}</Text>
              <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{a.p}</Text>
            </View>
          ))}
        </View>
      </BottomSheet>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  flex: { flex: 1, minWidth: 0 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  viewfinder: { width: 200, height: 200, borderRadius: 32, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  bigTitle: { fontSize: 24, lineHeight: 32, letterSpacing: -0.6, alignSelf: 'stretch', textAlign: 'center' },
  title: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5, alignSelf: 'stretch', textAlign: 'center' },
  small: { fontSize: 14, lineHeight: 22 },
  xs: { fontSize: 12, lineHeight: 16 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  eyebrow: { fontSize: 11, lineHeight: 16, letterSpacing: 1.6, paddingBottom: 8, paddingLeft: 4 },
  review: { gap: 24, paddingHorizontal: 16, paddingVertical: 16 },
  site: { alignItems: 'center', gap: 8 },
  siteIcon: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  me: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  shares: { gap: 12, paddingHorizontal: 4 },
  share: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  shareIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  cancel: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 },
  doneBadge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  about: { gap: 16 },
  aboutItem: { gap: 4 }
})
