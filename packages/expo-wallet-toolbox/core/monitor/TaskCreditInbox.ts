/**
 * Credits arriving PeerPay inbox payments when the device has signal.
 *
 * Triggering mirrors TaskSendOffline: gated on the app's single online signal,
 * with an immediate pass on reconnect / foreground / requestNow and exponential
 * backoff (10s → 5min) while auto-accept still has retryable work — and the
 * same idle backoff after a clean pass so sitting on Home still credits new
 * mail.
 *
 * All state is static and process-global BY DESIGN: the monitor is torn down
 * and rebuilt on network switches and wallet rebuilds, and a pending inbox
 * must survive that.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'

export interface CreditInboxTaskResult {
  accepted: number
  attention: number
  pending?: boolean
}

export class TaskCreditInbox extends WalletMonitorTask {
  static taskName = 'CreditInbox'

  static readonly BASE_BACKOFF_MS = 10_000
  static readonly MAX_BACKOFF_MS = 300_000

  /** An immediate pass has been requested. Consumed at the top of runTask. */
  static checkNow = false
  /** Last observation from the app's single online listener. Gates trigger. */
  static onlineNow = false
  /** The inbox may still have retryable work. Set pessimistically; a clean run clears it. */
  static hasPending = false
  static backoffMs = TaskCreditInbox.BASE_BACKOFF_MS
  static nextDueAt = 0
  /** Needs-attention count from the last successful pass, for the home-screen badge. */
  static lastAttentionCount = 0

  static noteConnectivity(online: boolean): void {
    TaskCreditInbox.onlineNow = online
    if (online) {
      TaskCreditInbox.checkNow = true
      TaskCreditInbox.backoffMs = TaskCreditInbox.BASE_BACKOFF_MS
      TaskCreditInbox.nextDueAt = 0
    }
  }

  /** New work may exist. Cheap to over-call: one idle pass clears it. */
  static noteEnqueued(): void {
    TaskCreditInbox.hasPending = true
    TaskCreditInbox.backoffMs = TaskCreditInbox.BASE_BACKOFF_MS
    TaskCreditInbox.nextDueAt = 0
  }

  static requestNow(): void {
    TaskCreditInbox.checkNow = true
    TaskCreditInbox.backoffMs = TaskCreditInbox.BASE_BACKOFF_MS
    TaskCreditInbox.nextDueAt = 0
  }

  static resetForTests(): void {
    TaskCreditInbox.checkNow = false
    TaskCreditInbox.onlineNow = false
    TaskCreditInbox.hasPending = false
    TaskCreditInbox.backoffMs = TaskCreditInbox.BASE_BACKOFF_MS
    TaskCreditInbox.nextDueAt = 0
    TaskCreditInbox.lastAttentionCount = 0
  }

  constructor(
    monitor: Monitor,
    private readonly credit: () => Promise<CreditInboxTaskResult>,
    private readonly now: () => number = () => Date.now(),
    private readonly onAccepted?: (count: number) => void
  ) {
    super(monitor, TaskCreditInbox.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    if (!TaskCreditInbox.onlineNow) return { run: false }
    if (TaskCreditInbox.checkNow) return { run: true }
    const due = nowMsecsSinceEpoch >= TaskCreditInbox.nextDueAt
    if (TaskCreditInbox.hasPending && due) return { run: true }
    // Idle poll after a clean pass: nextDueAt > 0 means a backoff was scheduled.
    if (TaskCreditInbox.nextDueAt > 0 && due) return { run: true }
    return { run: false }
  }

  private scheduleNext(pending: boolean): void {
    TaskCreditInbox.hasPending = pending
    TaskCreditInbox.nextDueAt = this.now() + TaskCreditInbox.backoffMs
    TaskCreditInbox.backoffMs = Math.min(TaskCreditInbox.backoffMs * 2, TaskCreditInbox.MAX_BACKOFF_MS)
  }

  async runTask(): Promise<string> {
    TaskCreditInbox.checkNow = false
    try {
      const r = await this.credit()
      TaskCreditInbox.lastAttentionCount = r.attention
      this.scheduleNext(!!r.pending)
      if (r.accepted > 0) {
        try {
          this.onAccepted?.(r.accepted)
        } catch {
          // A toast/sound failure must not turn a successful credit into a retry.
        }
      }
      if (r.accepted === 0 && r.attention === 0) return ''
      return `credited ${r.accepted}, attention ${r.attention}${r.pending ? ', pending' : ''}\n`
    } catch (e) {
      this.scheduleNext(true)
      return `CreditInbox failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
