// Backed up (the prototype's components/backup-done-art.tsx): the reverse of
// Forget wallet. The wallets' avatars drop back onto the tilted phone, the
// recovery phrase locks beside it, and a green check pops on the phone's
// corner with a burst of confetti.
import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { Check, LockKeyhole } from 'lucide-react-native'
import { font, useIsDark, usePalette } from '../theme'
import { Avatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { ConfettiBurst } from '../ui/Confetti'
import { enter, popIn, useReducedMotion, walletReturn } from '../ui/motion'
import { OVER_3D, SoftEllipse } from '../ui/Soft'
import { TiltedPhone } from './TiltedPhone'

// h-56 w-64
const W = 256
const H = 224
const RETURN = cubicBezier(0.34, 1.4, 0.64, 1)
const POP = cubicBezier(0.34, 1.8, 0.64, 1)

export interface DoneWallet {
  key: string
  portrait?: Portrait
  bg: AvatarBg
  uri?: string | null
}

export function BackupDoneArt({ wallets }: { wallets: DoneWallet[] }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const shown = wallets.slice(0, 3)
  // the confetti comes out of the check, once everything has landed
  const landed = 700 + shown.length * 180
  const [burst, setBurst] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setBurst(true), landed + 250)
    return () => clearTimeout(t)
  }, [landed])

  return (
    <View style={styles.stage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SoftEllipse frame={{ left: 40, top: 40, width: W - 80, height: H - 80 }} color={palette.positive} opacity={0.2} blur={40} />
      <SoftEllipse frame={{ left: W / 2 - 64, top: H - 48, width: 128, height: 24 }} color="#000000" opacity={dark ? 0.6 : 0.25} blur={24} />

      {/* the phone, same pose as Forget wallet */}
      <TiltedPhone pose={{ rx: 30, ry: 12, rz: 14 }} height={176} gap={6}>
        {/* the wallet rows, filled as their avatars land */}
        {shown.map((w, i) => (
          <View key={w.key} style={styles.row}>
            <Animated.View
              style={[styles.rowDot, { backgroundColor: palette.positive + 'b3' }, enter({ opacity: 0, duration: 300, delay: 700 + i * 180 })]}
            />
            <View style={[styles.rowLine, { backgroundColor: palette.mutedForeground + '40' }]} />
          </View>
        ))}
        <Animated.View style={[styles.backedUp, { backgroundColor: palette.positive }, enter({ opacity: 0, duration: 300, delay: landed })]}>
          <Text style={[font(700), styles.backedUpText]}>Backed up</Text>
        </Animated.View>
      </TiltedPhone>

      {/* the avatars, dropping back onto the screen */}
      {shown.map((w, i) => (
        <Animated.View
          key={w.key}
          style={[
            styles.avatar,
            { left: W * (0.38 + i * 0.12), boxShadow: `0 0 0 2px ${palette.background}, 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)` },
            still
              ? null
              : {
                  animationName: walletReturn,
                  animationDuration: 900,
                  animationDelay: i * 180,
                  animationTimingFunction: RETURN,
                  animationFillMode: 'both'
                }
          ]}
        >
          <Avatar portrait={w.portrait} bg={w.bg} uri={w.uri} size={34} />
        </Animated.View>
      ))}

      {/* the recovery phrase, locked, leaning on the phone */}
      <Animated.View style={[styles.note, enter({ opacity: 0, translateX: 16, duration: 500 })]}>
        <View
          style={[
            styles.noteCard,
            {
              backgroundColor: palette.card,
              boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}`
            }
          ]}
        >
          <View style={styles.noteHead}>
            <LockKeyhole size={10} color={palette.foreground} />
            <Text style={[font(700), styles.noteTitle, { color: palette.foreground }]}>Recovery phrase</Text>
          </View>
          <View style={styles.noteGrid}>
            {Array.from({ length: 12 }, (_, i) => (
              <View key={i} style={[styles.noteBar, { backgroundColor: palette.mutedForeground + '4d' }]} />
            ))}
          </View>
          <View
            style={[
              styles.lock,
              { backgroundColor: palette.ink, boxShadow: `0 0 0 2px ${palette.background}, 0 1px 3px rgba(0,0,0,0.1)` }
            ]}
          >
            <LockKeyhole size={12} color={palette.inkForeground} strokeWidth={2.5} />
          </View>
        </View>
      </Animated.View>

      {/* the check, popping on the phone's corner */}
      <Animated.View
        style={[
          styles.check,
          {
            backgroundColor: palette.positive,
            boxShadow: `0 0 0 4px ${palette.background}, 0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)`
          },
          {
            animationName: popIn,
            animationDuration: still ? 0 : 500,
            animationDelay: still ? 0 : landed,
            animationTimingFunction: POP,
            animationFillMode: 'both'
          }
        ]}
      >
        <Check size={24} color="#ffffff" strokeWidth={3.2} />
        {burst && <ConfettiBurst />}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  stage: { width: W, height: H, alignItems: 'center', justifyContent: 'center' },
  row: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowDot: { width: 16, height: 16, borderRadius: 8 },
  rowLine: { flex: 1, height: 4, borderRadius: 2 },
  backedUp: { marginTop: 'auto', marginBottom: 10, height: 20, width: '100%', borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  backedUpText: { fontSize: 8, lineHeight: 11, color: '#ffffff' },
  avatar: { position: 'absolute', zIndex: OVER_3D, top: H * 0.34, borderRadius: 17 },
  // bottom-7 -right-1 w-28 rotate-[8deg]
  note: { position: 'absolute', zIndex: OVER_3D, bottom: 28, right: -4, width: 112 },
  noteCard: { gap: 4, borderRadius: 8, padding: 8, transform: [{ rotate: '8deg' }] },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  noteTitle: { fontSize: 8, lineHeight: 11 },
  noteGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  noteBar: { height: 4, width: '31.5%', borderRadius: 2 },
  lock: { position: 'absolute', right: -8, top: -8, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  check: {
    position: 'absolute',
    zIndex: OVER_3D,
    left: W * 0.58,
    top: H * 0.14,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
