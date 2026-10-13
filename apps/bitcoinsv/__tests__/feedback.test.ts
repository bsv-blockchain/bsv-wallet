import { FEEDBACK_RULES, NO_FEEDBACK, shouldAsk, type FeedbackState } from '../src/feedback/rules'
import { flushNotes, queueNote, waitingNotes, type FeedbackNote, type OutboxDeps } from '../src/feedback/outbox'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const used = (p: Partial<FeedbackState> = {}): FeedbackState => ({ ...NO_FEEDBACK, paymentsSent: 5, appOpens: 10, ...p })

describe('when to ask "Enjoying Bitcoin SV Wallet?"', () => {
  it('waits for a few payments, or a few visits', () => {
    expect(shouldAsk({ ...NO_FEEDBACK, paymentsSent: FEEDBACK_RULES.minPayments - 1 }, 'payment', NOW)).toBe(false)
    expect(shouldAsk({ ...NO_FEEDBACK, paymentsSent: FEEDBACK_RULES.minPayments }, 'payment', NOW)).toBe(true)
    expect(shouldAsk({ ...NO_FEEDBACK, appOpens: FEEDBACK_RULES.minOpens - 1 }, 'visits', NOW)).toBe(false)
    expect(shouldAsk({ ...NO_FEEDBACK, appOpens: FEEDBACK_RULES.minOpens }, 'visits', NOW)).toBe(true)
  })

  it('leaves it a while after asking', () => {
    expect(shouldAsk(used({ lastAskedAt: ago(FEEDBACK_RULES.cooldownMs - DAY) }), 'visits', NOW)).toBe(false)
    expect(shouldAsk(used({ lastAskedAt: ago(FEEDBACK_RULES.cooldownMs + DAY) }), 'visits', NOW)).toBe(true)
  })

  it('leaves it longer after a rating or a note', () => {
    const past = ago(FEEDBACK_RULES.cooldownMs + DAY)
    expect(shouldAsk(used({ lastAskedAt: past, lovedAt: past }), 'visits', NOW)).toBe(false)
    expect(shouldAsk(used({ lastAskedAt: past, lovedAt: ago(FEEDBACK_RULES.afterLovedMs + DAY) }), 'visits', NOW)).toBe(true)
    expect(shouldAsk(used({ lastAskedAt: past, sentAt: past }), 'visits', NOW)).toBe(false)
    expect(shouldAsk(used({ lastAskedAt: past, sentAt: ago(FEEDBACK_RULES.afterSentMs + DAY) }), 'visits', NOW)).toBe(true)
  })
})

describe('notes to the team', () => {
  const note = (id: string): FeedbackNote => ({
    id,
    createdAt: '2026-10-12T12:00:00Z',
    topic: 'Speed',
    message: 'quicker please',
    source: 'prompt',
    app: { version: '1.0.0', build: '1', platform: 'ios', os: '26.5' },
    locale: 'en-GB'
  })
  const memory = () => {
    const store = new Map<string, string>()
    return {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v)
    } as unknown as OutboxDeps['storage']
  }
  const settle = () => new Promise(r => setTimeout(r, 0))

  it('waits on the phone while there is nowhere to send them', async () => {
    const storage = memory()
    const fetch = jest.fn()
    await queueNote(note('a'), { url: '', fetch, storage })
    await settle()
    expect(fetch).not.toHaveBeenCalled()
    expect(await waitingNotes(storage)).toBe(1)
  })

  it('goes, oldest first, once there is, and leaves the outbox', async () => {
    const storage = memory()
    await queueNote(note('a'), { url: '', fetch: jest.fn(), storage })
    await queueNote(note('b'), { url: '', fetch: jest.fn(), storage })
    const fetch = jest.fn(async () => ({ ok: true, status: 202 }) as Response)
    expect(await flushNotes({ url: 'https://feedback.example', fetch, storage })).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]).toEqual(['https://feedback.example/v1/feedback', expect.objectContaining({ method: 'POST' })])
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).id).toBe('a')
    expect(await waitingNotes(storage)).toBe(0)
  })

  it('keeps what the service couldn’t take for next time', async () => {
    const storage = memory()
    await queueNote(note('a'), { url: '', fetch: jest.fn(), storage })
    await queueNote(note('b'), { url: '', fetch: jest.fn(), storage })
    const down = jest.fn(async () => ({ ok: false, status: 503 }) as Response)
    expect(await flushNotes({ url: 'https://feedback.example', fetch: down, storage })).toBe(0)
    expect(await waitingNotes(storage)).toBe(2)
    const offline = jest.fn(async () => {
      throw new Error('offline')
    })
    expect(await flushNotes({ url: 'https://feedback.example', fetch: offline, storage })).toBe(0)
    expect(await waitingNotes(storage)).toBe(2)
  })

  it('lets go of a note the service turns away', async () => {
    const storage = memory()
    await queueNote(note('a'), { url: '', fetch: jest.fn(), storage })
    const refused = jest.fn(async () => ({ ok: false, status: 400 }) as Response)
    expect(await flushNotes({ url: 'https://feedback.example', fetch: refused, storage })).toBe(1)
    expect(await waitingNotes(storage)).toBe(0)
  })
})
