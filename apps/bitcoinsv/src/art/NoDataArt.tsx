// Welcome screen 3, "We don't want your data" (the prototype's NoDataArt in
// components/why-art.tsx): a phone with just you on it, and the things other
// apps ask for drifting up to it, getting crossed out and floating away. Loops.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Check, IdCard, KeyRound, Mail, Megaphone, Phone, Radar, ShieldCheck, UserRound, Wallet, type LucideIcon } from 'lucide-react-native'
import { font, useIsDark, usePalette } from '../theme'
import { dataRefused, dataStrike, useReducedMotion } from '../ui/motion'
import { OVER_3D, SoftEllipse } from '../ui/Soft'
import { TiltedPhone } from './TiltedPhone'

const ITEMS: { icon: LucideIcon; label: string; pos: object }[] = [
  { icon: Mail, label: 'Email', pos: { left: 0, top: 16 } },
  { icon: Megaphone, label: 'Ads', pos: { right: 8, top: 40 } },
  { icon: Phone, label: 'Phone number', pos: { left: -8, top: '45%' } },
  { icon: Radar, label: 'Tracking', pos: { right: 0, bottom: 64 } },
  { icon: IdCard, label: 'ID scan', pos: { left: 16, bottom: 16 } }
]

export function NoDataArt() {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const cycle = (name: typeof dataRefused, i: number) =>
    still
      ? null
      : { animationName: name, animationDuration: 4500, animationDelay: i * 900, animationIterationCount: 'infinite' as const, animationTimingFunction: 'ease-in-out' as const }
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SoftEllipse frame={{ left: 48, top: 48, width: 192, height: 160 }} color={palette.positive} opacity={0.2} blur={40} />
      <SoftEllipse frame={{ left: 80, top: 208, width: 128, height: 24 }} color="#000000" opacity={dark ? 0.6 : 0.25} blur={24} />
      {/* closer in, and leaning the other way from the first screen's phone */}
      <TiltedPhone pose={{ scale: 1.55, rx: 18, ry: -24, rz: -10 }}>
        {/* you hold the key, so the money and the data are yours */}
        <View style={[styles.key, { backgroundColor: palette.gold }]}>
          <KeyRound size={18} color={palette.goldForeground} strokeWidth={2.4} />
        </View>
        <Text style={[font(800), styles.headline, { color: palette.foreground }]}>{'Only you\nhold the key'}</Text>
        <View style={styles.rows}>
          {[
            { icon: Wallet, label: 'Your money' },
            { icon: UserRound, label: 'Your data' }
          ].map(({ icon: Icon, label }) => (
            <View key={label} style={[styles.row, { backgroundColor: palette.secondary }]}>
              <Icon size={8} color={palette.foreground} />
              <Text style={[font(700), styles.rowText, { color: palette.foreground }]}>{label}</Text>
              <Check size={8} color={palette.positive} strokeWidth={3.5} />
            </View>
          ))}
        </View>
        <View style={[styles.shared, { backgroundColor: palette.positive + '26' }]}>
          <ShieldCheck size={8} color={palette.positive} />
          <Text style={[font(700), styles.sharedText, { color: palette.positive }]}>Nothing shared</Text>
        </View>
      </TiltedPhone>
      {ITEMS.map(({ icon: Icon, label, pos }, i) => (
        <Animated.View
          key={label}
          style={[
            styles.chip,
            pos,
            {
              backgroundColor: palette.card,
              boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}`
            },
            cycle(dataRefused, i)
          ]}
        >
          <Icon size={14} color={palette.mutedForeground} />
          <View>
            <Text style={[font(600), styles.chipText, { color: palette.foreground }]}>{label}</Text>
            {/* the strike, drawn across once the chip arrives */}
            <Animated.View
              style={[styles.strike, { backgroundColor: palette.destructive, transformOrigin: 'left' }, still ? null : cycle(dataStrike, i)]}
            />
          </View>
        </Animated.View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // h-64 w-72
  box: { width: 288, height: 256, alignItems: 'center', justifyContent: 'center' },
  key: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  headline: { paddingTop: 6, textAlign: 'center', fontSize: 8, lineHeight: 10 },
  rows: { marginTop: 8, width: '100%', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 4 },
  rowText: { flex: 1, fontSize: 6.5, lineHeight: 9 },
  shared: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  sharedText: { fontSize: 6, lineHeight: 8 },
  chip: { position: 'absolute', zIndex: OVER_3D, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 12, lineHeight: 16 },
  strike: { position: 'absolute', left: 0, right: 0, top: 7, height: 2, borderRadius: 1 }
})
