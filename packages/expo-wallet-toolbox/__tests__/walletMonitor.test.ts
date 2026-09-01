import {
  boundReviewProvenTxs,
  configureNewHeaderPolling,
  createWalletMonitor,
  createWalletMonitorOptions,
  NEW_HEADER_FAILURE_BACKOFF_MS,
  NEW_HEADER_POLL_INTERVAL_MS,
  REVIEW_PROVEN_TXS_MAX_SPAN,
  REVIEW_PROVEN_TXS_MIN_INTERVAL_MS,
  reviewProvenTxsStartHeight
} from '../core/walletMonitor'
import { Monitor, Services } from '@bsv/wallet-toolbox-mobile'
import { TaskSendOffline } from '../core/monitor/TaskSendOffline'

function createTask(runTask: () => Promise<string>) {
  return {
    lastRunMsecsSinceEpoch: 0,
    triggerMsecs: NEW_HEADER_POLL_INTERVAL_MS,
    trigger: (_nowMsecsSinceEpoch: number) => ({ run: true }),
    runTask
  }
}

describe('configureNewHeaderPolling', () => {
  it('runs immediately, then respects the one-minute polling interval', async () => {
    const task = createTask(async () => 'ok')
    configureNewHeaderPolling(task)

    expect(task.trigger(1_000).run).toBe(true)
    await expect(task.runTask()).resolves.toBe('ok')

    task.lastRunMsecsSinceEpoch = 1_000
    expect(task.trigger(1_000 + NEW_HEADER_POLL_INTERVAL_MS - 1).run).toBe(false)
    expect(task.trigger(1_000 + NEW_HEADER_POLL_INTERVAL_MS).run).toBe(true)
  })

  it('backs off after a transient endpoint failure', async () => {
    const error = new Error('Bad Gateway')
    const onFailure = jest.fn()
    const task = createTask(async () => {
      throw error
    })
    configureNewHeaderPolling(task, { now: () => 10_000, onFailure })

    await expect(task.runTask()).resolves.toBe('')
    expect(onFailure).toHaveBeenCalledWith(error, 10_000 + NEW_HEADER_FAILURE_BACKOFF_MS)

    task.lastRunMsecsSinceEpoch = 10_000
    expect(task.trigger(10_000 + NEW_HEADER_POLL_INTERVAL_MS).run).toBe(false)
    expect(task.trigger(10_000 + NEW_HEADER_FAILURE_BACKOFF_MS).run).toBe(true)
  })
})

/**
 * Why the drain is registered BEFORE addDefaultTasks() in
 * context/WalletContext.tsx.
 *
 * Monitor.runOnce collects due tasks by walking `_tasks` and runs them in that
 * order, awaiting each (Monitor.js:188-215). So if TaskSendOffline sits after
 * TaskSendWaiting, one pass can broadcast a child of a still-queued transaction
 * before the drain has posted its parent — an orphan rejection, which is the
 * exact outcome this feature's release ordering exists to prevent.
 *
 * WalletContext itself has no test harness, so what is pinned here is the
 * upstream contract that its one line of ordering depends on, and which a
 * toolbox upgrade could quietly change: `_tasks` is push-ordered and
 * addDefaultTasks() appends to it rather than resetting it, and
 * createDefaultWalletMonitorOptions defaults startupTaskMode to 'none' so the
 * constructor registers nothing of its own.
 */
describe('monitor task registration order', () => {
  const build = () => {
    const services = new Services('test')
    const options = Monitor.createDefaultWalletMonitorOptions('test', {} as never, services)
    // If this ever defaults to 'default', the constructor adds TaskSendWaiting
    // itself and registering "before addDefaultTasks" stops meaning anything.
    expect(options.startupTaskMode).toBe('none')
    const monitor = new Monitor(options)
    expect(monitor._tasks).toHaveLength(0)
    const drain = new TaskSendOffline(monitor, async () => ({ sent: 0, rejected: 0, stopped: false }))
    return { monitor, drain }
  }
  const names = (monitor: Monitor) => monitor._tasks.map(t => t.name)

  it('puts the drain ahead of SendWaiting when it is added before the defaults', () => {
    const { monitor, drain } = build()
    monitor.addTask(drain)
    monitor.addDefaultTasks()

    const order = names(monitor)
    expect(order[0]).toBe('SendOffline')
    expect(order.indexOf('SendOffline')).toBeLessThan(order.indexOf('SendWaiting'))
  })

  it('puts it behind SendWaiting when it is added after them — the order this fixed', () => {
    const { monitor, drain } = build()
    monitor.addDefaultTasks()
    monitor.addTask(drain)

    const order = names(monitor)
    expect(order.indexOf('SendOffline')).toBeGreaterThan(order.indexOf('SendWaiting'))
  })

  it('keeps ReviewProvenTxs and Reorg on the default list', () => {
    const { monitor } = build()
    monitor.addDefaultTasks()
    const order = names(monitor)
    expect(order).toContain('ReviewProvenTxs')
    expect(order).toContain('Reorg')
  })
})

describe('createWalletMonitorOptions', () => {
  it('forwards the 4th argument as chaintracksWithEvents', () => {
    const services = new Services('test')
    const chaintracks = {
      subscribeReorgs: jest.fn().mockResolvedValue('reorg-sub'),
      subscribeHeaders: jest.fn().mockResolvedValue('header-sub')
    }
    const options = createWalletMonitorOptions('test', {} as never, services, chaintracks as never)
    expect(options.chaintracksWithEvents).toBe(chaintracks)
  })
})

describe('createWalletMonitor', () => {
  it('awaits ready so subscribeReorgs is registered', async () => {
    const services = new Services('test')
    const subscribeReorgs = jest.fn().mockResolvedValue('reorg-sub')
    const subscribeHeaders = jest.fn().mockResolvedValue('header-sub')
    const options = createWalletMonitorOptions('test', {} as never, services, {
      subscribeReorgs,
      subscribeHeaders
    } as never)
    const monitor = await createWalletMonitor(options)
    expect(subscribeReorgs).toHaveBeenCalled()
    expect(subscribeHeaders).toHaveBeenCalled()
    expect(monitor.chaintracksWithEvents).toBe(options.chaintracksWithEvents)
  })

  it('still returns the monitor if chaintracks subscribe rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const services = new Services('test')
    const subscribeReorgs = jest.fn().mockRejectedValue(new Error('Method not implemented.'))
    const subscribeHeaders = jest.fn().mockRejectedValue(new Error('Method not implemented.'))
    const options = createWalletMonitorOptions('test', {} as never, services, {
      subscribeReorgs,
      subscribeHeaders
    } as never)
    try {
      const monitor = await createWalletMonitor(options)
      expect(monitor.chaintracksWithEvents).toBe(options.chaintracksWithEvents)
      expect(subscribeReorgs).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('reviewProvenTxsStartHeight', () => {
  it('starts at lastReviewed+1 when the remaining span is within the bound', () => {
    expect(reviewProvenTxsStartHeight(890, 950)).toBe(891)
  })

  it('jumps to the last 100 eligible heights when far behind', () => {
    expect(reviewProvenTxsStartHeight(0, 900_000)).toBe(900_000 - REVIEW_PROVEN_TXS_MAX_SPAN + 1)
  })

  it('starts at 0 when the chain is shorter than the window', () => {
    expect(reviewProvenTxsStartHeight(undefined, 50)).toBe(0)
  })
})

describe('boundReviewProvenTxs', () => {
  it('does not run when the remaining height span exceeds 100', () => {
    const task = {
      lastRunMsecsSinceEpoch: 0,
      triggerMsecs: 1,
      trigger: (_now: number) => ({ run: true }),
      remainingHeightSpan: 101
    }
    boundReviewProvenTxs(task)
    expect(task.trigger(1).run).toBe(false)
  })

  it('still runs when the remaining height span is within 100', () => {
    const task = {
      lastRunMsecsSinceEpoch: 0,
      triggerMsecs: 1,
      trigger: (_now: number) => ({ run: true }),
      remainingHeightSpan: 100
    }
    boundReviewProvenTxs(task)
    expect(task.trigger(1).run).toBe(true)
  })

  it('skips the genesis crawl when last-reviewed is far behind tip', async () => {
    const task = {
      trigger: (_now: number) => ({ run: true }),
      maxHeightsPerRun: 500,
      minBlockAge: 100,
      remainingHeightSpan: 0,
      getLastReviewedHeight: async () => 0 as number | undefined,
      monitor: { chaintracks: { currentHeight: async () => 900_100 } }
    }
    boundReviewProvenTxs(task)
    expect(task.maxHeightsPerRun).toBe(REVIEW_PROVEN_TXS_MAX_SPAN)
    expect(await task.getLastReviewedHeight()).toBe(900_000 - REVIEW_PROVEN_TXS_MAX_SPAN)
  })

  it('does not run when getOnline returns false', () => {
    const task = {
      lastRunMsecsSinceEpoch: 0,
      trigger: (_now: number) => ({ run: true }),
      remainingHeightSpan: 1
    }
    boundReviewProvenTxs(task, { getOnline: () => false, now: () => 0 })
    expect(task.trigger(0).run).toBe(false)
  })

  it('runs at most every 10 minutes when online', () => {
    expect(REVIEW_PROVEN_TXS_MIN_INTERVAL_MS).toBe(600_000)
    let t = 1_000
    const task = {
      lastRunMsecsSinceEpoch: 0,
      trigger: (_now: number) => ({ run: true }),
      remainingHeightSpan: 1
    }
    boundReviewProvenTxs(task, { getOnline: () => true, now: () => t })
    expect(task.trigger(t).run).toBe(true)
    t = 1_000 + 60_000
    expect(task.trigger(t).run).toBe(false)
    t = 1_000 + REVIEW_PROVEN_TXS_MIN_INTERVAL_MS
    expect(task.trigger(t).run).toBe(true)
  })
})
