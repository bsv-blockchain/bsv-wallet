import { Monitor } from '@bsv/wallet-toolbox-mobile'

export const NEW_HEADER_POLL_INTERVAL_MS = 60_000
export const NEW_HEADER_FAILURE_BACKOFF_MS = 5 * 60_000
export const REVIEW_PROVEN_TXS_MAX_SPAN = 100

interface NewHeaderTask {
  lastRunMsecsSinceEpoch: number
  triggerMsecs?: number
  trigger: (nowMsecsSinceEpoch: number) => { run: boolean }
  runTask: () => Promise<string>
}

interface NewHeaderPollingOptions {
  now?: () => number
  pollIntervalMs?: number
  failureBackoffMs?: number
  onFailure?: (error: unknown, retryAt: number) => void
}

/**
 * The wallet SDK's TaskNewHeader declares a one-minute interval but its
 * trigger currently returns true on every five-second monitor cycle. Enforce
 * the intended cadence and back off transient Chaintracks gateway failures.
 */
export function configureNewHeaderPolling(task: NewHeaderTask, options: NewHeaderPollingOptions = {}) {
  const now = options.now ?? Date.now
  const pollIntervalMs = options.pollIntervalMs ?? Math.max(task.triggerMsecs ?? 0, NEW_HEADER_POLL_INTERVAL_MS)
  const failureBackoffMs = options.failureBackoffMs ?? NEW_HEADER_FAILURE_BACKOFF_MS
  const originalRunTask = task.runTask.bind(task)
  let retryAt = 0

  task.trigger = (nowMsecsSinceEpoch: number) => ({
    run:
      nowMsecsSinceEpoch >= retryAt &&
      (task.lastRunMsecsSinceEpoch === 0 || nowMsecsSinceEpoch - task.lastRunMsecsSinceEpoch >= pollIntervalMs)
  })

  task.runTask = async () => {
    try {
      const log = await originalRunTask()
      retryAt = 0
      return log
    } catch (error) {
      retryAt = now() + failureBackoffMs
      options.onFailure?.(error, retryAt)
      return ''
    }
  }
}

export function createWalletMonitorOptions(
  ...args: Parameters<typeof Monitor.createDefaultWalletMonitorOptions>
): ReturnType<typeof Monitor.createDefaultWalletMonitorOptions> {
  return Monitor.createDefaultWalletMonitorOptions(...args)
}

/**
 * Construct a Monitor and await `ready` so `_init` registers
 * `subscribeReorgs` / `subscribeHeaders` on `chaintracksWithEvents`.
 * Subscribe failures must not kill the rest of the task loop: the HTTP
 * ChaintracksServiceClient still throws "Method not implemented" for those
 * methods, and TaskReviewProvenTxs is the backup audit in that case.
 */
export async function createWalletMonitor(
  options: ReturnType<typeof Monitor.createDefaultWalletMonitorOptions>
): Promise<Monitor> {
  const monitor = new Monitor(options)
  try {
    await monitor.ready
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[walletMonitor] chaintracks subscribe failed; TaskReorg will not receive live events: ${message}`)
  }
  return monitor
}

/**
 * Last-reviewed is stored as the height already done; runTask starts at last+1.
 * When that would crawl more than `maxSpan` heights, jump to the last window
 * instead of walking from genesis.
 */
export function reviewProvenTxsStartHeight(
  lastReviewedHeight: number | undefined,
  maxEligibleHeight: number,
  maxSpan = REVIEW_PROVEN_TXS_MAX_SPAN
): number {
  const unbounded = lastReviewedHeight === undefined ? 0 : lastReviewedHeight + 1
  const floor = maxEligibleHeight - maxSpan + 1
  return Math.max(0, unbounded, floor)
}

interface ReviewProvenTxsLike {
  trigger: (nowMsecsSinceEpoch: number) => { run: boolean }
  remainingHeightSpan?: number
  maxHeightsPerRun?: number
  minBlockAge?: number
  getLastReviewedHeight?: () => Promise<number | undefined>
  monitor?: {
    chaintracksWithEvents?: { currentHeight: () => Promise<number> }
    chaintracks: { currentHeight: () => Promise<number> }
  }
}

/**
 * Keep TaskReviewProvenTxs, but do not let it crawl the whole chain: skip a
 * trigger whose remaining span is over 100, and if last-reviewed is far
 * behind the tip, start at the last 100 eligible heights.
 */
export function boundReviewProvenTxs(task: ReviewProvenTxsLike): void {
  if (typeof task.maxHeightsPerRun === 'number') {
    task.maxHeightsPerRun = Math.min(task.maxHeightsPerRun, REVIEW_PROVEN_TXS_MAX_SPAN)
  }
  const originalTrigger = task.trigger.bind(task)
  task.trigger = (nowMsecsSinceEpoch: number) => {
    const base = originalTrigger(nowMsecsSinceEpoch)
    if (!base.run) return base
    if ((task.remainingHeightSpan ?? 0) > REVIEW_PROVEN_TXS_MAX_SPAN) return { run: false }
    return base
  }

  const monitor = task.monitor
  if (!task.getLastReviewedHeight || !monitor) return
  const originalGetLast = task.getLastReviewedHeight.bind(task)
  task.getLastReviewedHeight = async () => {
    const last = await originalGetLast()
    const ct = monitor.chaintracksWithEvents || monitor.chaintracks
    const tip = await ct.currentHeight()
    const maxEligible = tip - (task.minBlockAge ?? 0)
    const maxSpan = task.maxHeightsPerRun ?? REVIEW_PROVEN_TXS_MAX_SPAN
    const start = reviewProvenTxsStartHeight(last, maxEligible, maxSpan)
    const unbounded = last === undefined ? 0 : last + 1
    task.remainingHeightSpan = Math.max(0, maxEligible - start + 1)
    if (start > unbounded) return start - 1
    return last
  }
}
