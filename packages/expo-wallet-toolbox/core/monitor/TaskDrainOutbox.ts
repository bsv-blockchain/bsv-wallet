/**
 * Retries unsent PeerPay outbox entries when the device has signal.
 *
 * Triggering mirrors TaskSendOffline: gated on the app's single online signal,
 * with an immediate pass on reconnect / foreground / requestNow and exponential
 * backoff (10s → 5min) while unsent rows remain. Delivery is idempotent.
 * The first thrown retry stops the pass — remaining entries wait for the next
 * backoff rather than compounding a down message box.
 *
 * All state is static and process-global BY DESIGN: the monitor is torn down
 * and rebuilt on network switches and wallet rebuilds, and a pending outbox
 * must survive that.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import type { OutboxEntry } from '../peerpay/outbox'

export interface DrainOutboxResult {
  retried: number
  remaining: number
  stopped?: boolean
}

/** Retry unsent entries in order; the first throw aborts the rest. */
export async function drainUnsentEntries(args: {
  entries: OutboxEntry[]
  retry: (entry: OutboxEntry) => Promise<void>
}): Promise<DrainOutboxResult> {
  let retried = 0
  for (const entry of args.entries) {
    await args.retry(entry)
    retried++
  }
  return { retried, remaining: args.entries.length - retried, stopped: false }
}

export class TaskDrainOutbox extends WalletMonitorTask {
  static taskName = 'DrainOutbox'

  static readonly BASE_BACKOFF_MS = 10_000
  static readonly MAX_BACKOFF_MS = 300_000

  /** An immediate pass has been requested. Consumed at the top of runTask. */
  static checkNow = false
  /** Last observation from the app's single online listener. Gates trigger. */
  static onlineNow = false
  /** The outbox may still hold unsent rows. Set pessimistically; a clean run clears it. */
  static hasPending = false
  static backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
  static nextDueAt = 0

  static noteConnectivity(online: boolean): void {
    TaskDrainOutbox.onlineNow = online
    if (online) {
      TaskDrainOutbox.checkNow = true
      TaskDrainOutbox.backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
      TaskDrainOutbox.nextDueAt = 0
    }
  }

  /** New work exists. Cheap to over-call: one idle drain clears it. */
  static noteEnqueued(): void {
    TaskDrainOutbox.hasPending = true
    TaskDrainOutbox.backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
    TaskDrainOutbox.nextDueAt = 0
  }

  static requestNow(): void {
    TaskDrainOutbox.checkNow = true
    TaskDrainOutbox.backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
    TaskDrainOutbox.nextDueAt = 0
  }

  static resetForTests(): void {
    TaskDrainOutbox.checkNow = false
    TaskDrainOutbox.onlineNow = false
    TaskDrainOutbox.hasPending = false
    TaskDrainOutbox.backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
    TaskDrainOutbox.nextDueAt = 0
  }

  constructor(
    monitor: Monitor,
    private readonly drain: () => Promise<DrainOutboxResult>,
    private readonly now: () => number = () => Date.now(),
    private readonly prune?: () => Promise<void>
  ) {
    super(monitor, TaskDrainOutbox.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    if (!TaskDrainOutbox.onlineNow) return { run: false }
    return {
      run: TaskDrainOutbox.checkNow || (TaskDrainOutbox.hasPending && nowMsecsSinceEpoch >= TaskDrainOutbox.nextDueAt)
    }
  }

  private scheduleRetry(): void {
    TaskDrainOutbox.hasPending = true
    TaskDrainOutbox.nextDueAt = this.now() + TaskDrainOutbox.backoffMs
    TaskDrainOutbox.backoffMs = Math.min(TaskDrainOutbox.backoffMs * 2, TaskDrainOutbox.MAX_BACKOFF_MS)
  }

  async runTask(): Promise<string> {
    TaskDrainOutbox.checkNow = false
    try {
      const r = await this.drain()
      if (r.stopped || r.remaining > 0) {
        this.scheduleRetry()
      } else {
        TaskDrainOutbox.hasPending = false
        TaskDrainOutbox.backoffMs = TaskDrainOutbox.BASE_BACKOFF_MS
      }
      await this.prune?.()
      if (r.retried === 0 && !r.stopped && r.remaining === 0) return ''
      return `drained ${r.retried}, remaining ${r.remaining}${r.stopped ? ', stopped early' : ''}\n`
    } catch (e) {
      this.scheduleRetry()
      return `DrainOutbox failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
