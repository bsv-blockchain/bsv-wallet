// Scan & pay (the prototype's app/(wallet)/pay/page.tsx), on the shared core
// (decision 12): scan the payee's code with the camera. A pay link, identity
// key or address goes on to Pay with them filled in (the amount too, when the
// code asks for one). A till's or phone's nearby-payment code hands over to
// the core's NearbyFlow, which pays over the radio it can reach (AWDL,
// Bluetooth) or falls back to a QR fountain; it is the existing app's flow,
// unchanged, so its screens are its own.
//
// The idle screen is the prototype's: the dark scanner tile with its gold
// corners. Tapping it plays the sweep line and opens the camera. Not here,
// unlike the prototype: "or hold near a phone" (a nearby payment starts from
// the till's or phone's code, scanned here).
import { POS_PREFIX, decodePaymentRequest } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import Animated, { css } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ScanLine } from 'lucide-react-native'
import { classifyScan } from '@bsv/expo-wallet-toolbox'
import { NearbyFlow, QRScanner } from '@bsv/expo-wallet-toolbox/ui'
import type { Session } from '@bsv/expo-wallet-toolbox/core/localpay/session'
import { font, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { showToast } from '../src/ui/Toast'
import { useReducedMotion } from '../src/ui/motion'
import { PayTabs } from '../src/pay/PayTabs'
import { isSignInCode } from '../src/signin/code'

/** The tile's size: aspect-square w-full max-w-[260px]. */
const TILE = 260
/** How long the sweep plays before the camera opens: it reaches the bottom. */
const OPEN_AFTER = 700

/** @keyframes scan-sweep — top 12% → 84% → 12%, fading in and out at the ends. */
const scanSweep = (size: number) =>
  css.keyframes({
    '0%': { opacity: 0, transform: [{ translateY: size * 0.12 }] },
    '15%': { opacity: 1 },
    '50%': { transform: [{ translateY: size * 0.84 }] },
    '85%': { opacity: 1 },
    '100%': { opacity: 0, transform: [{ translateY: size * 0.12 }] }
  })

/** The four gold corner brackets (size-8, 3px borders, rounded-xl, inset 16). */
const CORNERS = [
  { top: 16, left: 16, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
  { top: 16, right: 16, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
  { bottom: 16, left: 16, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 },
  { bottom: 16, right: 16, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 12 }
] as const

export default function ScanAndPay() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const still = useReducedMotion()
  const { width } = useWindowDimensions()
  const size = Math.min(TILE, width - 32)
  const sweep = useMemo(() => scanSweep(size), [size])
  const [scanning, setScanning] = useState(false)
  // the sweep line playing, on its way to the camera
  const [sweeping, setSweeping] = useState(false)
  const [nearby, setNearby] = useState<Session | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const startScan = () => {
    if (sweeping) return
    if (still) {
      setScanning(true)
      return
    }
    setSweeping(true)
    timer.current = setTimeout(() => {
      setSweeping(false)
      setScanning(true)
    }, OPEN_AFTER)
  }

  if (nearby) return <NearbyFlow role="payer" initialSession={nearby} onExit={() => setNearby(null)} dismissTo="/" />

  const onScan = async (data: string) => {
    if (data.startsWith(POS_PREFIX)) {
      setScanning(false)
      try { setNearby(await decodePaymentRequest(data)) }
      catch { showToast('Invalid or expired merchant payment request.', { type: 'error' }) }
      return
    }
    // a website's sign-in code: on to Sign in with it
    if (isSignInCode(data)) {
      setScanning(false)
      router.replace({ pathname: '/sign-in', params: { code: data } })
      return
    }
    const target = classifyScan(data)
    setScanning(false)
    if (!target) {
      showToast('That code isn’t one Bitcoin SV Wallet can pay.', { type: 'error' })
      return
    }
    if (target.kind === 'nearby') setNearby(target.session)
    // a pay link, key or address: on to Pay, with what the code says
    else router.replace({ pathname: '/send', params: { link: data } })
  }

  if (scanning) return <QRScanner onScan={onScan} onClose={() => setScanning(false)} hintText="Point at the code on their screen or the till" />

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top, paddingBottom: insets.bottom + 16 }]}>
      <PageHeader
        title="Scan & pay"
        action={
          <ViewInfo
            about="Pay"
            text="Paying in person? Scan their code with the camera. Paying someone next to you works over Bluetooth, or with a code if there’s no signal. Confirm, done."
          />
        }
      />
      <PayTabs active="/pay" />

      {/* scanner */}
      <View style={styles.scanner}>
        <Pressable
          onPress={startScan}
          accessibilityRole="button"
          accessibilityLabel="Scan to pay"
          style={[styles.tile, { width: size, height: size, boxShadow: `0 0 0 1px ${palette.border}` }]}
        >
          {CORNERS.map((c, i) => (
            <View key={i} pointerEvents="none" style={[styles.corner, c, { borderColor: palette.gold }]} />
          ))}
          {sweeping && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.sweep,
                {
                  backgroundColor: palette.gold,
                  boxShadow: `0 0 12px 2px ${palette.gold}99`,
                  animationName: sweep,
                  animationDuration: 1400,
                  animationTimingFunction: 'ease-in-out',
                  animationFillMode: 'both'
                }
              ]}
            />
          )}
          <View pointerEvents="none" style={styles.label}>
            <ScanLine size={24} color="#ffffff" />
            <Text style={[font(400), styles.labelText]}>Scan to pay</Text>
          </View>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 24, paddingHorizontal: 16 },
  scanner: { alignItems: 'center' },
  // rounded-[28px] bg-neutral-900 ring-1 ring-border
  tile: { borderRadius: 28, backgroundColor: '#171717', alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 32, height: 32 },
  // absolute inset-x-6 h-0.5 rounded-full
  sweep: { position: 'absolute', top: 0, left: 24, right: 24, height: 2, borderRadius: 1 },
  label: { maxWidth: 160, alignItems: 'center', gap: 8 },
  labelText: {
    color: '#ffffff',
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6
  }
})
