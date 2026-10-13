// "Back up your keys" (the prototype's components/backup-nudge.tsx): the big
// card from the bottom, once money first lands in a wallet whose phrase isn't
// backed up (src/notify/PaymentAlerts sets prefs.backupNudge). A moment after
// it's due, so the payment's own toast comes first. "Back up now" opens the
// backup; "Not now" or the cross puts it away for good.
import React, { useEffect, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyRound, X } from 'lucide-react-native'
import { font } from '../theme'
import { Backdrop } from '../ui/Backdrop'
import { enter, useReducedMotion } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'
import { PressScale } from '../ui/PressScale'
import { SeedPaperArt } from '../art/SeedPaperArt'
import { setPref, usePrefs } from '../state/prefs'

export function BackupNudge({ backedUp, onBackUp }: { backedUp: boolean; onBackUp: () => void }) {
  const prefs = usePrefs()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!prefs.backupNudge || backedUp) return
    const t = setTimeout(() => setShown(true), 2600)
    return () => clearTimeout(t)
  }, [prefs.backupNudge, backedUp])

  const dismiss = () => {
    setShown(false)
    setPref('backupNudge', false)
  }
  // feedback-prompt.tsx's rise(i): 12px up over 500ms, ease-out, 90ms apart
  const rise = (i: number) => (still ? null : enter({ translateY: 12, duration: 500, delay: 120 + i * 90, easing: 'ease-out' }))

  return (
    // no Modal fade: the scrim fades in over 300ms and the card fades with its
    // own slide (fade-in slide-in-from-bottom-10 duration-700 ease-out), not twice
    <Modal transparent visible={shown} animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={dismiss}>
      <View style={styles.anchor}>
        <Animated.View style={[StyleSheet.absoluteFill, still ? null : enter({ duration: 300 })]}>
          <Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={dismiss} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.card, { marginBottom: Math.max(12, insets.bottom) }, still ? null : enter({ translateY: 40, duration: 700, easing: 'ease-out' })]}
        >
          <Backdrop tint="mint" />
          <View style={styles.grab} />
          <Pressable onPress={dismiss} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <X size={16} color="rgba(255,255,255,0.6)" />
          </Pressable>
          <View style={styles.body}>
            <Animated.View style={[styles.art, rise(0)]}>
              <SeedPaperArt />
            </Animated.View>
            <Animated.Text accessibilityRole="header" style={[font(700), styles.title, rise(1)]}>
              Back up your keys
            </Animated.Text>
            <Animated.View style={[styles.balanced, rise(2)]}>
              <BalancedText style={[font(400), styles.text]}>
                There’s money in your wallet now. Write down your recovery phrase, so you can get it back if you lose this phone.
              </BalancedText>
            </Animated.View>
            <Animated.View style={[styles.actions, rise(3)]}>
              <View style={styles.ctaWrap}>
              <PressScale
                onPress={() => {
                  dismiss()
                  onBackUp()
                }}
                accessibilityRole="button"
                scale={0.98}
                style={styles.cta}
              >
                <KeyRound size={18} color="#161618" />
                <Text style={[font(600), styles.ctaText]}>Back up now</Text>
              </PressScale>
              </View>
              <Pressable onPress={dismiss} accessibilityRole="button" style={styles.later}>
                <Text style={[font(500), styles.laterText]}>Not now</Text>
              </Pressable>
            </Animated.View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  scrim: { backgroundColor: 'rgba(0,0,0,0.5)' },
  card: { width: '94%', maxWidth: 448, borderRadius: 32, overflow: 'hidden', backgroundColor: '#161618', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' },
  grab: { alignSelf: 'center', marginTop: 12, width: 48, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  close: { position: 'absolute', right: 12, top: 12, zIndex: 10, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  body: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 16, paddingBottom: 32 },
  art: { height: 208, width: '100%', alignItems: 'center', justifyContent: 'center' },
  title: { width: '100%', paddingTop: 8, fontSize: 24, lineHeight: 32, letterSpacing: -0.6, color: '#ffffff', textAlign: 'center' },
  text: { width: '100%', paddingTop: 8, fontSize: 15, lineHeight: 24, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
  balanced: { alignSelf: 'stretch' },
  actions: { width: '100%', alignItems: 'center', gap: 4, paddingTop: 32 },
  ctaWrap: { alignSelf: 'stretch' },
  cta: { height: 56, width: '100%', borderRadius: 28, backgroundColor: '#ffffff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaText: { fontSize: 16, lineHeight: 24, color: '#161618' },
  later: { height: 48, width: '100%', alignItems: 'center', justifyContent: 'center' },
  laterText: { fontSize: 16, lineHeight: 24, color: 'rgba(255,255,255,0.75)' }
})
