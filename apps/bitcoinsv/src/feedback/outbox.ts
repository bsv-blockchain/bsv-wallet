// Notes to the team ("I don't like it", or Help → Send feedback), kept on the
// phone until they're delivered: the feedback service isn't built yet, so each
// one waits in this outbox and goes once EXPO_PUBLIC_FEEDBACK_URL is set (on
// the next launch, or the next note). docs/backend-integration.md, Feedback,
// has the endpoint.
//
// A note carries what was typed and what the app is, nothing that identifies
// the person or their wallet.
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface FeedbackNote {
  /** made on the phone; the service can drop a repeat */
  id: string
  createdAt: string
  /** the chip picked, if any ("Payments", "Speed", …) */
  topic: string | null
  /** what they wrote, if anything */
  message: string
  /** where it was written: the "Enjoying?" card or Help */
  source: 'prompt' | 'help'
  app: { version: string; build: string | null; platform: string; os: string }
  locale: string | null
}

const KEY = 'bitcoinsv.feedback.outbox.v1'
/** At most this many wait; the oldest go first */
const MAX_WAITING = 50

export interface OutboxDeps {
  url: string
  fetch: typeof fetch
  storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem'>
}

const read = async (storage: OutboxDeps['storage']): Promise<FeedbackNote[]> => {
  try {
    const raw = await storage.getItem(KEY)
    return raw ? (JSON.parse(raw) as FeedbackNote[]) : []
  } catch {
    return []
  }
}

const write = (storage: OutboxDeps['storage'], notes: FeedbackNote[]) => storage.setItem(KEY, JSON.stringify(notes.slice(-MAX_WAITING))).catch(() => {})

/** Keep a note (resolved once it's kept), then try to send everything waiting. */
export async function queueNote(note: FeedbackNote, deps: OutboxDeps): Promise<void> {
  await write(deps.storage, [...(await read(deps.storage)), note])
  void flushNotes(deps).catch(() => {})
}

let flushing: Promise<number> | null = null

/** Send what's waiting, oldest first; what doesn't go stays for next time. How many went. */
export function flushNotes(deps: OutboxDeps): Promise<number> {
  if (!deps.url) return Promise.resolve(0)
  // one at a time: a second call waits on the first
  flushing ??= (async () => {
    const waiting = await read(deps.storage)
    let sent = 0
    for (const note of waiting) {
      try {
        const res = await deps.fetch(`${deps.url}/v1/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(note)
        })
        // the service is down: try again later. A note it turns away (4xx)
        // would never go, so that one is let go with the sent ones
        if (res.status >= 500) break
        sent++
      } catch {
        break
      }
    }
    if (sent) {
      // what's waiting now, less what went (more may have come meanwhile)
      const done = new Set(waiting.slice(0, sent).map(n => n.id))
      await write(deps.storage, (await read(deps.storage)).filter(n => !done.has(n.id)))
    }
    return sent
  })().finally(() => {
    flushing = null
  })
  return flushing
}

/** How many notes are waiting to go. */
export async function waitingNotes(storage: OutboxDeps['storage'] = AsyncStorage): Promise<number> {
  return (await read(storage)).length
}
