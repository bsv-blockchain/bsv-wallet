// Settings → Why Bitcoin SV Wallet (the prototype's components/about-sheet.tsx):
// the case in three numbers against what people pay with today, then the
// reasons, then the small print.
import React from 'react'
import { Image, Linking, StyleSheet, Text, View } from 'react-native'
import { AtSign, Bell, KeyRound, Lock, PiggyBank, Zap, type LucideIcon } from 'lucide-react-native'
import Constants from 'expo-constants'
import { font, radii, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { BalancedText } from '../ui/BalancedText'
import { ICON_IMAGES, useAppIcon } from './appIcons'

const VERSUS = [
  { value: '<1¢', label: 'per payment', them: ['Credit cards:', '3% + 30¢'] },
  { value: 'Seconds', label: 'to settle', them: ['Credit cards:', 'days'] },
  { value: '0', label: 'personal details', them: ['Others:', 'email, ID'] }
]

const REASONS: { Icon: LucideIcon; title: string; body: string }[] = [
  { Icon: Zap, title: 'Instant, like cash', body: 'Money arrives in seconds, any time, anywhere.' },
  { Icon: PiggyBank, title: 'Keep more of your money', body: 'Under a cent a payment, not a credit card’s 3% + 30¢.' },
  { Icon: AtSign, title: 'No crypto skills needed', body: 'Pay a handle like @john, not a long address.' },
  { Icon: KeyRound, title: 'Yours, and only yours', body: 'No email, phone or ID. Only you hold the keys.' },
  // this app has no passcode of its own: the phone's lock guards the keys
  { Icon: Lock, title: 'Locked to you', body: 'Your phone’s Face ID or passcode guards the keys.' },
  { Icon: Bell, title: 'Always in the know', body: 'An alert for every payment, the moment it lands.' }
]

export const APP_VERSION = Constants.expoConfig?.version ?? '1.0'

export function AboutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const palette = usePalette()
  // the icon as your home screen shows it (Settings → App icon)
  const icon = useAppIcon()
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Why Bitcoin SV Wallet" hideHeader>
      <View style={styles.head}>
        <View style={[styles.icon, { boxShadow: '0 10px 28px -10px rgba(234,179,0,0.6), 0 0 0 1px rgba(0,0,0,0.05)' }]}>
          <Image source={ICON_IMAGES[icon]} style={styles.iconImage} />
        </View>
        <BalancedText style={[font(700), styles.title, { color: palette.foreground }]}>Money that moves like a message.</BalancedText>
        <BalancedText style={[font(400), styles.sub, { color: palette.mutedForeground }]}>
          Faster and cheaper than paying by credit card, and only you hold it.
        </BalancedText>
      </View>

      <View style={styles.versus}>
        {VERSUS.map(v => (
          <View key={v.label} style={[styles.box, { backgroundColor: palette.gold + '26' }]}>
            <Text style={[font(800), styles.big, { color: palette.foreground }]}>{v.value}</Text>
            <Text style={[font(600), styles.boxLabel, { color: palette.foreground }]}>{v.label}</Text>
            <Text style={[font(400), styles.them, { color: palette.mutedForeground }]}>
              {v.them[0]}
              {'\n'}
              {v.them[1]}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.reasons}>
        {REASONS.map(({ Icon, title, body }) => (
          <View key={title} style={styles.reason}>
            <View style={[styles.ring, { borderColor: palette.border }]}>
              <Icon size={16} color={palette.foreground} />
            </View>
            <View style={styles.flex}>
              <Text style={[font(600), styles.reasonTitle, { color: palette.foreground }]}>{title}</Text>
              <Text style={[font(400), styles.reasonBody, { color: palette.mutedForeground }]}>{body}</Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>
        Bitcoin SV Wallet {APP_VERSION}
        {'\n'}Found something odd?{' '}
        <Text
          accessibilityRole="link"
          onPress={() => void Linking.openURL('mailto:security@bitcoinsv.com')}
          style={[font(500), { color: palette.foreground, textDecorationLine: 'underline' }]}
        >
          security@bitcoinsv.com
        </Text>
      </Text>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 12, paddingTop: 16, paddingBottom: 4 },
  icon: { width: 64, height: 64, borderRadius: 20, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconImage: { width: 64, height: 64 },
  title: { fontSize: 18, lineHeight: 24, textAlign: 'center', letterSpacing: -0.3 },
  sub: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: -4 },
  versus: { flexDirection: 'row', gap: 8 },
  box: { flex: 1, alignItems: 'center', borderRadius: radii['2xl'], paddingHorizontal: 8, paddingVertical: 12 },
  big: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  boxLabel: { fontSize: 11, lineHeight: 13, textAlign: 'center' },
  them: { fontSize: 10, lineHeight: 13, textAlign: 'center', paddingTop: 6 },
  reasons: { gap: 16, paddingVertical: 4 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ring: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  reasonTitle: { fontSize: 14, lineHeight: 20 },
  reasonBody: { fontSize: 12, lineHeight: 19, paddingTop: 2 },
  small: { fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: 4 }
})
