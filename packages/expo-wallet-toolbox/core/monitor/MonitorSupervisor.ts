/**
 * Runs the wallet monitor's pass loop under a watchdog.
 *
 * `Monitor.startTasks()` is `while (running) { await runOnce(); await wait }`.
 * Two things end that loop with no signal to anyone:
 *
 *  · a task whose `await` never resolves — runOnce runs tasks sequentially
 *    with no per-task timeout, so one hung network or SQLite call parks every
 *    other task behind it, TaskSendWaiting included;
 *  · `runOnce`'s own catch block calling `logEvent`, which is a SQLite write —
 *    if that throws, the error escapes `startTasks` and the loop is gone.
 *
 * Seen 2026-09-18: Clock ticks stopped at 13:29:01 while the app stayed in
 * use; two ordinary BSV sends made minutes later sat at `sending` until the
 * app was force-quit, because nothing but the monitor broadcasts an `unsent`
 * request.
 *
 * So the loop is driven from here instead. Each completed pass stamps
 * `lastPassAt`; the host polls `isStalled` and calls `restart`, which starts a
 * new generation of the loop on the SAME monitor. The old generation, if its
 * hung await ever resolves, sees the generation change and exits rather than
 * running alongside the new one. A pass that throws is logged and does not end
 * the loop.
 *
 * `_tasksRunning` and `_tasksRunningPromise` are kept in step with what
 * `Monitor.startTasks` would have set, because `stopTasks()` clears the first
 * and `stopMonitorAndDrain` awaits the second.
 */
import type { Monitor } from '@bsv/wallet-toolbox-mobile'

/** No completed pass for this long, while the app is active, means the loop is gone. */
export const MONITOR_STALL_MS = 120_000

/** The private loop state the toolbox's own `startTasks` maintains. */
interface LoopState {
  _tasksRunning: boolean
  _tasksRunningPromise?: Promise<void>
  resolveCompletion?: () => void
  runOnce(): Promise<void>
  options: { taskRunWaitMsecs: number }
}

export class MonitorSupervisor {
  /** When the most recent pass completed (or the loop was started/touched). */
  lastPassAt: number
  /** How many times `restart` has run. Exposed for logging and tests. */
  restarts = 0
  private generation = 0
  private monitor: Monitor | undefined

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly warn: (message: string, error?: unknown) => void = (m, e) => console.warn(m, e ?? '')
  ) {
    this.lastPassAt = this.now()
  }

  /** Begin driving `monitor`. Replaces `monitor.startTasks()`; never awaited. */
  start(monitor: Monitor): void {
    this.monitor = monitor
    const state = monitor as unknown as LoopState
    state._tasksRunning = true
    state._tasksRunningPromise = new Promise<void>(resolve => {
      state.resolveCompletion = resolve
    })
    this.lastPassAt = this.now()
    void this.loop(state, ++this.generation)
  }

  /**
   * Something else proves the loop is not stalled — the app just came back to
   * the foreground and the loop's timers were frozen with it. Resets the clock
   * so the first watchdog check after a resume cannot fire on a gap that was
   * the OS's, not the monitor's.
   */
  touch(): void {
    this.lastPassAt = this.now()
  }

  isStalled(stallMs: number = MONITOR_STALL_MS): boolean {
    const state = this.monitor as unknown as LoopState | undefined
    if (!state?._tasksRunning) return false
    return this.now() - this.lastPassAt > stallMs
  }

  /**
   * Start a new generation of the loop on the current monitor. The stalled
   * generation is abandoned: when (if) its await resolves it exits on the
   * generation check. Returns false when there is no running monitor to restart.
   */
  restart(): boolean {
    const state = this.monitor as unknown as LoopState | undefined
    if (!state?._tasksRunning) return false
    this.restarts++
    this.lastPassAt = this.now()
    void this.loop(state, ++this.generation)
    return true
  }

  private async loop(state: LoopState, generation: number): Promise<void> {
    while (state._tasksRunning && generation === this.generation) {
      try {
        await state.runOnce()
      } catch (e) {
        // The toolbox loop dies here. A failed pass is a failed pass; the next
        // one runs.
        this.warn('[MonitorSupervisor] monitor pass failed', e)
      }
      if (generation !== this.generation) return
      this.lastPassAt = this.now()
      await this.wait(state.options.taskRunWaitMsecs)
    }
    // Only the live generation may report completion: an abandoned one waking
    // up late must not resolve a drain that belongs to its successor.
    if (generation === this.generation && state.resolveCompletion) {
      state.resolveCompletion()
      state.resolveCompletion = undefined
    }
  }
}
