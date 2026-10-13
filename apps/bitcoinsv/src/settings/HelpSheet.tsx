// Help & support (the prototype's components/support-sheet.tsx, its quick
// answers): the common questions, each opening its answer in place. The
// prototype's scripted support chat is Later, and its answers promised things
// no one has decided (a sending limit, regulated partners, fees paid for you),
// so these answer from what the app does. Under them, a note to the team
// (src/feedback), and where to report a security issue.
import React, { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, MessageSquareText } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { BottomSheet, afterSheetCloses } from '../ui/BottomSheet'
import { openFeedbackForm } from '../feedback/feedback'

const QUICK: { q: string; a: string }[] = [
  {
    q: 'How long do payments take?',
    a: 'Payments between Bitcoin SV Wallet users arrive in seconds, any time of day. Activity shows each one’s real status until it’s settled.'
  },
  {
    q: 'What are the fees?',
    a: 'Bitcoin SV Wallet doesn’t charge you to send or receive. Each payment carries a small network fee, usually well under a cent.'
  },
  {
    q: 'Is my money safe?',
    a: 'Only you hold the keys to your wallet. They’re on this phone, behind its Face ID or passcode, and your recovery phrase or key slices bring them back on another. Bitcoin SV Wallet can’t see or move your money.'
  },
  {
    q: 'How do I move to a new phone?',
    a: 'On the new phone, tap “Used Bitcoin SV Wallet before? Sign in”, then enter your recovery phrase or scan two of your key slices. Sync brings back your payments and contacts.'
  },
  {
    q: 'I sent money to the wrong person',
    a: 'Payments can’t be reversed once they’re sent, so ask the person to send it back. A payment still waiting to send can be cancelled from its details in Activity.'
  }
]

export function HelpSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const palette = usePalette()
  const [shown, setShown] = useState<number | null>(null)
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Help & support" description="Answers to what people ask most.">
      <View>
        <Text style={[font(600), styles.heading, { color: palette.mutedForeground }]}>QUICK ANSWERS</Text>
        <View style={styles.list}>
          {QUICK.map(({ q, a }, i) => {
            const on = shown === i
            return (
              <View key={q}>
                <Pressable
                  onPress={() => setShown(on ? null : i)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: on }}
                  style={({ pressed }) => [styles.q, pressed && { backgroundColor: palette.secondary + '99' }]}
                >
                  <Text style={[font(500), styles.small, styles.flex, { color: palette.foreground }]}>{q}</Text>
                  <ChevronDown size={16} color={palette.mutedForeground} style={on ? styles.flip : undefined} />
                </Pressable>
                {on && <Text style={[font(400), styles.small, styles.a, { color: palette.mutedForeground }]}>{a}</Text>}
              </View>
            )
          })}
        </View>
      </View>
      {/* a note to the team, once this sheet is out of the way */}
      <Pressable
        onPress={() => {
          onOpenChange(false)
          afterSheetCloses(openFeedbackForm)
        }}
        accessibilityRole="button"
        style={({ pressed }) => [styles.feedback, { backgroundColor: pressed ? palette.secondary : palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
      >
        <MessageSquareText size={18} color={palette.foreground} />
        <View style={styles.flex}>
          <Text style={[font(600), styles.small, { color: palette.foreground }]}>Send feedback</Text>
          <Text style={[font(400), styles.xs, styles.left, { color: palette.mutedForeground }]}>Tell the team what’s working and what isn’t</Text>
        </View>
        <ChevronRight size={16} color={palette.mutedForeground} />
      </Pressable>
      <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
        Found something odd?{' '}
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
  heading: { fontSize: 11, lineHeight: 16, letterSpacing: 1.1, paddingBottom: 6, paddingLeft: 4 },
  list: { marginHorizontal: -8 },
  q: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 12 },
  a: { paddingHorizontal: 8, paddingBottom: 12 },
  feedback: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 14, paddingVertical: 12 },
  flex: { flex: 1 },
  left: { textAlign: 'left', paddingBottom: 0 },
  flip: { transform: [{ rotate: '180deg' }] },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: 4 }
})
