// The "Enjoying Bitcoin SV Wallet?" card (the prototype's FeedbackPrompt in
// components/feedback-prompt.tsx), over the whole app: the dragon on the
// brand gold, "I love it" on to the store's rating, "I don't like it" to a
// short note for the team. Opened from Help, it's the note alone. When and
// whether it asks is src/feedback/feedback.ts. The prototype's RatingSheet is
// a stand-in for the store's own sheet, which is what this opens.
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { font } from '../theme'
import { Avatar } from '../ui/Avatar'
import { Backdrop } from '../ui/Backdrop'
import { BalancedText } from '../ui/BalancedText'
import { PressScale } from '../ui/PressScale'
import { showToast } from '../ui/Toast'
import { enter, medallionFloat, useReducedMotion } from '../ui/motion'
import { closeFeedback, flushFeedback, countFeedbackEvent, loveIt, sendFeedback, useFeedbackCard, type FeedbackView } from './feedback'

const TOPICS = ['Payments', 'Speed', 'Design', 'Something’s missing', 'Other'] as const

/** Counted once a launch, toward "after a few visits" */
let counted = false

export function FeedbackHost() {
  const card = useFeedbackCard()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const [view, setView] = useState<FeedbackView>('ask')
  // each time it opens, from where it was opened
  const [opened, setOpened] = useState(card)
  if (card !== opened) {
    setOpened(card)
    if (card) setView(card.view)
  }

  // this launch counts as a visit; and a note still waiting may go now
  useEffect(() => {
    if (counted) return
    counted = true
    countFeedbackEvent('open')
    flushFeedback()
  }, [])

  // feedback-prompt.tsx's rise(i): 12px up over 500ms, ease-out, 90ms apart
  const rise = (i: number) => (still ? null : enter({ translateY: 12, duration: 500, delay: 120 + i * 90, easing: 'ease-out' }))

  return (
    <Modal transparent visible={!!card} animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={closeFeedback}>
      <KeyboardAvoidingView style={styles.anchor} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[StyleSheet.absoluteFill, still ? null : enter({ duration: 300 })]}>
          <Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={closeFeedback} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.card, { marginBottom: Math.max(12, insets.bottom) }, still ? null : enter({ translateY: 40, duration: 700, easing: 'ease-out' })]}
        >
          <Backdrop tint="gold" />
          <View style={styles.grab} />
          <Pressable onPress={closeFeedback} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <X size={16} color="rgba(255,255,255,0.6)" />
          </Pressable>
          {view === 'ask' ? (
            <AskView rise={rise} still={still} onDislike={() => setView('form')} />
          ) : (
            <FormView rise={rise} fromHelp={card?.source === 'help'} />
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

type Rise = (i: number) => object | null

function AskView({ rise, still, onDislike }: { rise: Rise; still: boolean; onDislike: () => void }) {
  const love = async () => {
    closeFeedback()
    const outcome = await loveIt()
    if (outcome === 'later') showToast('Thank you!', { type: 'success', description: 'Ratings open once Bitcoin SV Wallet is in the store.' })
  }
  return (
    <View style={styles.askBody}>
      <Animated.View style={rise(0)}>
        {/* the dragon on the brand gold, floating (medallion-float) */}
        <Animated.View style={[styles.medallion, still ? null : { animationName: medallionFloat, animationDuration: 5000, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }]}>
          <Avatar portrait="dragon" bg="butter" size={128} />
        </Animated.View>
      </Animated.View>
      <Animated.Text accessibilityRole="header" style={[font(700), styles.title, rise(1)]}>
        Enjoying Bitcoin SV Wallet?
      </Animated.Text>
      <Animated.View style={[styles.stretch, rise(2)]}>
        <BalancedText style={[font(400), styles.text]}>Tell us what you think. Your feedback makes Bitcoin SV Wallet better.</BalancedText>
      </Animated.View>
      <Animated.View style={[styles.actions, rise(3)]}>
        <Cta label="I love it" onPress={() => void love()} />
        <Pressable onPress={onDislike} accessibilityRole="button" style={styles.quiet}>
          <Text style={[font(500), styles.quietText]}>I don’t like it</Text>
        </Pressable>
      </Animated.View>
    </View>
  )
}

function FormView({ rise, fromHelp }: { rise: Rise; fromHelp: boolean }) {
  const [topic, setTopic] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const canSend = (topic !== null || text.trim().length > 0) && !busy
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    try {
      await sendFeedback(topic, text, fromHelp ? 'help' : 'prompt')
      showToast('Thanks for your feedback', { type: 'success', description: 'It goes straight to our team.' })
      closeFeedback()
    } catch {
      setBusy(false)
      showToast('Couldn’t save that', { type: 'error', description: 'Try again in a moment.' })
    }
  }
  return (
    <View style={styles.formBody}>
      <Animated.Text accessibilityRole="header" style={[font(700), styles.formTitle, rise(0)]}>
        {fromHelp ? 'Send feedback' : 'Sorry to hear that'}
      </Animated.Text>
      <Animated.Text style={[font(400), styles.formText, rise(1)]}>
        {fromHelp ? 'What’s working, and what isn’t? It goes straight to our team.' : 'What isn’t working for you? It goes straight to our team.'}
      </Animated.Text>
      <Animated.View style={[styles.topics, rise(2)]}>
        {TOPICS.map(t => {
          const on = topic === t
          return (
            <Pressable
              key={t}
              onPress={() => setTopic(on ? null : t)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.topic, on ? styles.topicOn : styles.topicOff]}
            >
              <Text style={[font(500), styles.topicText, { color: on ? '#161618' : 'rgba(255,255,255,0.8)' }]}>{t}</Text>
            </Pressable>
          )
        })}
      </Animated.View>
      <Animated.View style={rise(3)}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Tell us more (optional)"
          placeholderTextColor="rgba(255,255,255,0.4)"
          multiline
          textAlignVertical="top"
          maxLength={2000}
          accessibilityLabel="Tell us more"
          style={[font(400), styles.input]}
        />
      </Animated.View>
      <Animated.View style={[styles.sendWrap, rise(4)]}>
        {/* dimmed inside: the rise's fill would hold the outer view at full opacity */}
        <View style={!canSend && styles.disabled}>
          <Cta label="Send feedback" onPress={() => void send()} disabled={!canSend} />
        </View>
      </Animated.View>
    </View>
  )
}

/** The white pill on the dark card, the card's full width */
function Cta({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <View style={styles.ctaWrap}>
      <PressScale onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} scale={0.98} style={styles.cta}>
        <Text style={[font(600), styles.ctaText]}>{label}</Text>
      </PressScale>
    </View>
  )
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  scrim: { backgroundColor: 'rgba(0,0,0,0.5)' },
  card: { width: '94%', maxWidth: 448, borderRadius: 32, overflow: 'hidden', backgroundColor: '#161618', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' },
  grab: { alignSelf: 'center', marginTop: 12, width: 48, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  close: { position: 'absolute', right: 12, top: 12, zIndex: 10, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  // pt-10 under the grab handle's 12 + 4
  askBody: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 24, paddingBottom: 32 },
  // shadow-2xl ring-4 ring-white/15
  medallion: { borderRadius: 64, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25), 0 0 0 4px rgba(255,255,255,0.15)' },
  title: { width: '100%', paddingTop: 32, fontSize: 24, lineHeight: 32, letterSpacing: -0.6, color: '#ffffff', textAlign: 'center' },
  text: { width: '100%', paddingTop: 8, fontSize: 15, lineHeight: 24, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },
  actions: { width: '100%', alignItems: 'center', gap: 4, paddingTop: 32 },
  ctaWrap: { alignSelf: 'stretch' },
  cta: { height: 56, width: '100%', borderRadius: 28, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: 16, lineHeight: 24, color: '#161618' },
  quiet: { height: 48, width: '100%', alignItems: 'center', justifyContent: 'center' },
  quietText: { fontSize: 16, lineHeight: 24, color: 'rgba(255,255,255,0.75)' },
  // px-6 pb-6 pt-8, under the grab handle
  formBody: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24 },
  formTitle: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5, color: '#ffffff' },
  formText: { paddingTop: 4, fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.7)' },
  topics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 20 },
  topic: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  topicOn: { backgroundColor: '#ffffff', boxShadow: '0 0 0 1px #ffffff' },
  topicOff: { backgroundColor: 'rgba(255,255,255,0.05)', boxShadow: '0 0 0 1px rgba(255,255,255,0.15)' },
  topicText: { fontSize: 14, lineHeight: 20 },
  input: {
    marginTop: 16,
    minHeight: 112,
    borderRadius: 16,
    padding: 16,
    fontSize: 15,
    lineHeight: 22,
    color: '#ffffff',
    backgroundColor: 'rgba(255,255,255,0.1)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.15)'
  },
  sendWrap: { marginTop: 20 },
  disabled: { opacity: 0.4 }
})
