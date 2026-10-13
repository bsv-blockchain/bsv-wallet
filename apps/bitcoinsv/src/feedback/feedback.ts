// "Enjoying Bitcoin SV Wallet?" (the prototype's components/feedback-prompt
// .tsx and its store's requestFeedback): asked at calm moments, after a few
// payments or a few visits (src/feedback/rules.ts), and never on top of
// anything else. "I love it" goes on to the store's rating; "I don't like it"
// to a short note for the team (src/feedback/outbox.ts). Help → Send feedback
// opens the note directly. The card itself is FeedbackHost, over the app.
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { getLocales } from 'expo-localization'
import { getPrefs, setPref } from '../state/prefs'
import { FEEDBACK_URL, asksFirst } from './config'
import { flushNotes, queueNote, type FeedbackNote } from './outbox'
import { isListed, rateTheApp, type RateOutcome } from './review'
import { shouldAsk, type FeedbackReason } from './rules'

export type FeedbackView = 'ask' | 'form'

let shown: { view: FeedbackView; source: FeedbackNote['source'] } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

/** The card, if it's up: its first view, and where it was opened from. */
export function useFeedbackCard() {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => shown
  )
}

const patch = (p: Partial<ReturnType<typeof getPrefs>['feedback']>) => setPref('feedback', { ...getPrefs().feedback, ...p })

/**
 * Ask, if this is a good moment: the rules, and nothing else in the way (a
 * wallet not set up, the backup reminder waiting, the app in the background).
 * `force` (development builds) skips the rules.
 */
export function requestFeedback(reason: FeedbackReason, force = false): void {
  const prefs = getPrefs()
  if (shown || !prefs.onboarded) return
  if (!force && (prefs.backupNudge || AppState.currentState !== 'active' || !shouldAsk(prefs.feedback, reason))) return
  // without the question (Android, per Google Play's rules): the store's own
  // sheet at the same moment. It can only show once the app is listed; until
  // then nothing's asked, so nothing counts as asked
  if (!asksFirst(Platform.OS) && !force) {
    if (!isListed()) return
    patch({ lastAskedAt: new Date().toISOString() })
    void rateTheApp()
    return
  }
  patch({ lastAskedAt: new Date().toISOString() })
  shown = { view: 'ask', source: 'prompt' }
  emit()
}

/**
 * A moment after leaving a success screen, once the next one has settled:
 * never on top of the moment itself.
 */
export function askForFeedbackSoon(reason: FeedbackReason = 'payment'): void {
  setTimeout(() => requestFeedback(reason), 700)
}

/** A payment sent, or the app opened: toward the rules. */
export function countFeedbackEvent(kind: 'payment' | 'open'): void {
  const f = getPrefs().feedback
  patch(kind === 'payment' ? { paymentsSent: f.paymentsSent + 1 } : { appOpens: f.appOpens + 1 })
}

/** Help → Send feedback: straight to the note. */
export function openFeedbackForm(): void {
  if (shown) return
  shown = { view: 'form', source: 'help' }
  emit()
}

export function closeFeedback(): void {
  if (!shown) return
  shown = null
  emit()
}

/** "I love it": on to the store's rating. */
export async function loveIt(): Promise<RateOutcome> {
  patch({ lovedAt: new Date().toISOString() })
  return rateTheApp()
}

const deps = () => ({ url: FEEDBACK_URL, fetch, storage: AsyncStorage })

/** A note for the team: kept, then sent when there's somewhere to send it. */
export async function sendFeedback(topic: string | null, message: string, source: FeedbackNote['source']): Promise<void> {
  patch({ sentAt: new Date().toISOString() })
  const config = Constants.expoConfig
  await queueNote(
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: new Date().toISOString(),
      topic,
      message: message.trim(),
      source,
      app: {
        version: config?.version ?? '',
        build: (Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode?.toString()) ?? null,
        platform: Platform.OS,
        os: String(Platform.Version)
      },
      locale: getLocales()[0]?.languageTag ?? null
    },
    deps()
  )
}

/** On launch: anything still waiting goes, now there may be somewhere to send it. */
export function flushFeedback(): void {
  void flushNotes(deps()).catch(() => {})
}
