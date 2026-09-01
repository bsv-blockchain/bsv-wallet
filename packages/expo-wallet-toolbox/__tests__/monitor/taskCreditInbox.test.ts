import { TaskCreditInbox } from '../../core/monitor/TaskCreditInbox'
import { creditInboxOnce, resetCreditInboxForTests } from '../../core/pay/creditInbox'
import { loadInboxAttempts, saveInboxAttempts } from '../../core/peerpay/inboxAttempts'
import type { IncomingPayment } from '@bsv/message-box-client'

const monitor = {} as never

type CreditResult = { accepted: number; attention: number; pending?: boolean }

function task(results: CreditResult[], nowRef: { t: number }) {
  const calls: number[] = []
  const t = new TaskCreditInbox(
    monitor,
    async () => {
      calls.push(nowRef.t)
      const r = results.shift()
      if (!r) throw new Error('credit called more times than the test planned')
      return r
    },
    () => nowRef.t
  )
  return { t, calls }
}

const idle: CreditResult = { accepted: 0, attention: 0, pending: false }
const pending: CreditResult = { accepted: 0, attention: 1, pending: true }

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('TaskCreditInbox trigger', () => {
  beforeEach(() => TaskCreditInbox.resetForTests())

  it('never runs while offline, even with checkNow set', () => {
    TaskCreditInbox.noteConnectivity(false)
    TaskCreditInbox.checkNow = true
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(false)
  })

  it('reconnecting arms an immediate run', () => {
    TaskCreditInbox.noteConnectivity(true)
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })

  it('does not fire periodically before the first run has scheduled a backoff', () => {
    TaskCreditInbox.noteConnectivity(true)
    TaskCreditInbox.checkNow = false
    const { t } = task([], { t: 0 })
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('fires periodically while pending and online', () => {
    TaskCreditInbox.noteConnectivity(true)
    TaskCreditInbox.checkNow = false
    TaskCreditInbox.noteEnqueued()
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })
})

describe('TaskCreditInbox backoff', () => {
  beforeEach(() => TaskCreditInbox.resetForTests())

  it('a pending run schedules the next attempt 10s out, then doubles to the 5min cap', async () => {
    const nowRef = { t: 1_000 }
    TaskCreditInbox.noteConnectivity(true)
    const { t } = task([pending, pending, pending], nowRef)

    await t.runTask()
    expect(t.trigger(10_999).run).toBe(false)
    expect(t.trigger(11_000).run).toBe(true)

    nowRef.t = 11_000
    await t.runTask()
    expect(t.trigger(30_999).run).toBe(false)
    expect(t.trigger(31_000).run).toBe(true)

    nowRef.t = 31_000
    await t.runTask().catch(() => {})
    expect(TaskCreditInbox.backoffMs).toBe(80_000)
    TaskCreditInbox.backoffMs = 400_000
    nowRef.t = 500_000
    const { t: t2 } = task([pending], nowRef)
    await t2.runTask()
    expect(TaskCreditInbox.backoffMs).toBeLessThanOrEqual(TaskCreditInbox.MAX_BACKOFF_MS)
  })

  it('a clean run clears pending and keeps 10s→5min idle backoff while online', async () => {
    const nowRef = { t: 0 }
    TaskCreditInbox.noteConnectivity(true)
    TaskCreditInbox.noteEnqueued()
    const { t } = task([idle, idle, idle], nowRef)
    await t.runTask()
    expect(TaskCreditInbox.hasPending).toBe(false)
    expect(t.trigger(9_999).run).toBe(false)
    expect(t.trigger(10_000).run).toBe(true)

    nowRef.t = 10_000
    await t.runTask()
    expect(TaskCreditInbox.hasPending).toBe(false)
    expect(t.trigger(29_999).run).toBe(false)
    expect(t.trigger(30_000).run).toBe(true)

    nowRef.t = 30_000
    await t.runTask()
    expect(TaskCreditInbox.backoffMs).toBe(80_000)
  })

  it('a throwing credit is a stopped run, not a dead task', async () => {
    const nowRef = { t: 0 }
    TaskCreditInbox.noteConnectivity(true)
    const t = new TaskCreditInbox(
      monitor,
      async () => {
        throw new Error('boom')
      },
      () => nowRef.t
    )
    const log = await t.runTask()
    expect(log).toContain('boom')
    expect(TaskCreditInbox.hasPending).toBe(true)
    expect(t.trigger(TaskCreditInbox.BASE_BACKOFF_MS).run).toBe(true)
  })

  it('requestNow and noteEnqueued reset the backoff', () => {
    TaskCreditInbox.noteConnectivity(true)
    TaskCreditInbox.backoffMs = 160_000
    TaskCreditInbox.nextDueAt = 999_999
    TaskCreditInbox.requestNow()
    expect(TaskCreditInbox.backoffMs).toBe(TaskCreditInbox.BASE_BACKOFF_MS)
    expect(TaskCreditInbox.checkNow).toBe(true)

    TaskCreditInbox.backoffMs = 160_000
    TaskCreditInbox.nextDueAt = 999_999
    TaskCreditInbox.noteEnqueued()
    expect(TaskCreditInbox.backoffMs).toBe(TaskCreditInbox.BASE_BACKOFF_MS)
    expect(TaskCreditInbox.nextDueAt).toBe(0)
  })

  it('stores lastAttentionCount from the credit port', async () => {
    const nowRef = { t: 0 }
    TaskCreditInbox.noteConnectivity(true)
    const { t } = task([{ accepted: 0, attention: 2, pending: true }], nowRef)
    await t.runTask()
    expect(TaskCreditInbox.lastAttentionCount).toBe(2)
  })

  it('notifies once when a pass accepts payments', async () => {
    const onAccepted = jest.fn()
    const task = new TaskCreditInbox(monitor, async () => ({ accepted: 2, attention: 0 }), Date.now, onAccepted)
    await task.runTask()
    expect(onAccepted).toHaveBeenCalledWith(2)
  })

  it('does not notify when accepted is 0', async () => {
    const onAccepted = jest.fn()
    const task = new TaskCreditInbox(monitor, async () => ({ accepted: 0, attention: 1 }), Date.now, onAccepted)
    await task.runTask()
    expect(onAccepted).not.toHaveBeenCalled()
  })
})

describe('inbox attempts KV', () => {
  it('round-trips attempts through KV', async () => {
    const s = fakeStorage()
    await saveInboxAttempts(s, { m1: { attempts: 2, error: 'x' } })
    expect(await loadInboxAttempts(s)).toEqual({ m1: { attempts: 2, error: 'x' } })
  })
})

const payment = (id: string): IncomingPayment =>
  ({
    messageId: id,
    sender: '02aa',
    token: {
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      transaction: [1, 2, 3],
      amount: 5
    }
  }) as IncomingPayment

describe('creditInboxOnce', () => {
  beforeEach(() => resetCreditInboxForTests())

  it('lists, diffs damaged, skips them, persists attempts, and threads classify', async () => {
    const s = fakeStorage()
    const classify = jest.fn().mockReturnValue('structural')
    const accept = jest.fn().mockRejectedValue(new Error('no derivation'))
    const client = {
      listIncomingPayments: jest.fn().mockResolvedValue([payment('m1')]),
      listMessages: jest.fn().mockResolvedValue([
        { messageId: 'm1', sender: '02aa', body: payment('m1').token },
        { messageId: 'junk', sender: '02bb', body: '[Error: Failed to decrypt]' }
      ]),
      sendMessage: jest.fn()
    }
    const r = await creditInboxOnce({
      client,
      messageBoxUrl: 'https://mb',
      storage: s,
      accept,
      classify
    })
    expect(client.listMessages).toHaveBeenCalledWith({
      messageBox: 'payment_inbox',
      host: 'https://mb',
      acceptPayments: false
    })
    expect(r.damaged.map(d => d.messageId)).toEqual(['junk'])
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0][0].messageId).toBe('m1')
    expect(classify).toHaveBeenCalled()
    expect(await loadInboxAttempts(s)).toEqual(r.attempts)
    expect(r.attempts.m1?.attempts).toBe(1)
    expect(r.attentionCount).toBe(1)
  })

  it('joins an in-flight pass instead of starting a second one', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => {
      release = r
    })
    const accept = jest.fn(async () => {
      await gate
    })
    const client = {
      listIncomingPayments: jest.fn().mockResolvedValue([payment('a')]),
      listMessages: jest.fn().mockResolvedValue([]),
      sendMessage: jest.fn()
    }
    const first = creditInboxOnce({ client, messageBoxUrl: 'https://mb', storage: fakeStorage(), accept })
    const second = creditInboxOnce({ client, messageBoxUrl: 'https://mb', storage: fakeStorage(), accept })
    release()
    await Promise.all([first, second])
    expect(accept).toHaveBeenCalledTimes(1)
    expect(client.listIncomingPayments).toHaveBeenCalledTimes(1)
  })
})
