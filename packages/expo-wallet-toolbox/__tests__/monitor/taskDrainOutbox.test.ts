import { drainUnsentEntries, TaskDrainOutbox } from '../../core/monitor/TaskDrainOutbox'
import type { OutboxEntry } from '../../core/peerpay/outbox'

const monitor = {} as never

type DrainResult = { retried: number; remaining: number; stopped?: boolean }

function task(results: DrainResult[], nowRef: { t: number }) {
  const calls: number[] = []
  const t = new TaskDrainOutbox(
    monitor,
    async () => {
      calls.push(nowRef.t)
      const r = results.shift()
      if (!r) throw new Error('drain called more times than the test planned')
      return r
    },
    () => nowRef.t
  )
  return { t, calls }
}

const idle: DrainResult = { retried: 0, remaining: 0, stopped: false }
const stuck: DrainResult = { retried: 0, remaining: 1, stopped: true }

function entry(id: string): OutboxEntry {
  return {
    id,
    createdAt: new Date().toISOString(),
    recipient: '02aa',
    token: {
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      transaction: [1],
      amount: 1
    },
    messageBoxUrl: 'https://mb',
    status: 'unsent'
  }
}

describe('TaskDrainOutbox trigger', () => {
  beforeEach(() => TaskDrainOutbox.resetForTests())

  it('never runs while offline, even with checkNow set', () => {
    TaskDrainOutbox.noteConnectivity(false)
    TaskDrainOutbox.checkNow = true
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(false)
  })

  it('reconnecting arms an immediate run', () => {
    TaskDrainOutbox.noteConnectivity(true)
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })

  it('does not fire periodically with nothing pending', () => {
    TaskDrainOutbox.noteConnectivity(true)
    TaskDrainOutbox.checkNow = false
    const { t } = task([], { t: 0 })
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('fires periodically while pending and online', () => {
    TaskDrainOutbox.noteConnectivity(true)
    TaskDrainOutbox.checkNow = false
    TaskDrainOutbox.noteEnqueued()
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })
})

describe('TaskDrainOutbox backoff', () => {
  beforeEach(() => TaskDrainOutbox.resetForTests())

  it('a stopped run schedules the next attempt 10s out, then doubles to the 5min cap', async () => {
    const nowRef = { t: 1_000 }
    TaskDrainOutbox.noteConnectivity(true)
    const { t } = task([stuck, stuck, stuck], nowRef)

    await t.runTask()
    expect(t.trigger(10_999).run).toBe(false)
    expect(t.trigger(11_000).run).toBe(true)

    nowRef.t = 11_000
    await t.runTask()
    expect(t.trigger(30_999).run).toBe(false)
    expect(t.trigger(31_000).run).toBe(true)

    nowRef.t = 31_000
    await t.runTask().catch(() => {})
    expect(TaskDrainOutbox.backoffMs).toBe(80_000)
    TaskDrainOutbox.backoffMs = 400_000
    nowRef.t = 500_000
    const { t: t2 } = task([stuck], nowRef)
    await t2.runTask()
    expect(TaskDrainOutbox.backoffMs).toBeLessThanOrEqual(TaskDrainOutbox.MAX_BACKOFF_MS)
  })

  it('a clean run clears pending and resets backoff', async () => {
    const nowRef = { t: 0 }
    TaskDrainOutbox.noteConnectivity(true)
    TaskDrainOutbox.noteEnqueued()
    const { t } = task([idle], nowRef)
    await t.runTask()
    expect(TaskDrainOutbox.hasPending).toBe(false)
    expect(TaskDrainOutbox.backoffMs).toBe(TaskDrainOutbox.BASE_BACKOFF_MS)
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('a throwing drain is a stopped run, not a dead task', async () => {
    const nowRef = { t: 0 }
    TaskDrainOutbox.noteConnectivity(true)
    const t = new TaskDrainOutbox(
      monitor,
      async () => {
        throw new Error('boom')
      },
      () => nowRef.t
    )
    const log = await t.runTask()
    expect(log).toContain('boom')
    expect(TaskDrainOutbox.hasPending).toBe(true)
    expect(t.trigger(TaskDrainOutbox.BASE_BACKOFF_MS).run).toBe(true)
  })

  it('requestNow and noteEnqueued reset the backoff', () => {
    TaskDrainOutbox.noteConnectivity(true)
    TaskDrainOutbox.backoffMs = 160_000
    TaskDrainOutbox.nextDueAt = 999_999
    TaskDrainOutbox.requestNow()
    expect(TaskDrainOutbox.backoffMs).toBe(TaskDrainOutbox.BASE_BACKOFF_MS)
    expect(TaskDrainOutbox.checkNow).toBe(true)

    TaskDrainOutbox.backoffMs = 160_000
    TaskDrainOutbox.nextDueAt = 999_999
    TaskDrainOutbox.noteEnqueued()
    expect(TaskDrainOutbox.backoffMs).toBe(TaskDrainOutbox.BASE_BACKOFF_MS)
    expect(TaskDrainOutbox.nextDueAt).toBe(0)
  })

  it('prunes expired sent entries after a successful drain', async () => {
    const prune = jest.fn().mockResolvedValue(undefined)
    TaskDrainOutbox.noteConnectivity(true)
    const t = new TaskDrainOutbox(monitor, async () => idle, () => 0, prune)
    await t.runTask()
    expect(prune).toHaveBeenCalledTimes(1)
  })
})

describe('drainUnsentEntries', () => {
  it('retries each unsent entry and stops after the first throw', async () => {
    const retry = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('box down'))
      .mockResolvedValueOnce(undefined)
    await expect(drainUnsentEntries({ entries: [entry('a'), entry('b'), entry('c')], retry })).rejects.toThrow(
      'box down'
    )
    expect(retry).toHaveBeenCalledTimes(2)
    expect(retry.mock.calls.map(c => c[0].id)).toEqual(['a', 'b'])
  })
})
