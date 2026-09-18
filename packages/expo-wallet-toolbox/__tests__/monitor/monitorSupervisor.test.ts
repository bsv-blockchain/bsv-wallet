import { MONITOR_STALL_MS, MonitorSupervisor } from '../../core/monitor/MonitorSupervisor'

type FakeMonitor = {
  _tasksRunning: boolean
  _tasksRunningPromise?: Promise<void>
  resolveCompletion?: () => void
  runOnce: jest.Mock<Promise<void>, []>
  options: { taskRunWaitMsecs: number }
  stopTasks(): void
}

function fakeMonitor(runOnce: jest.Mock<Promise<void>, []>): FakeMonitor {
  const m: FakeMonitor = {
    _tasksRunning: false,
    runOnce,
    options: { taskRunWaitMsecs: 5000 },
    stopTasks() {
      m._tasksRunning = false
    }
  }
  return m
}

/** A controllable clock plus a `wait` that resolves on the next microtask, so loops run without timers. */
function harness() {
  let now = 1_000_000
  const waits: Array<() => void> = []
  const supervisor = new MonitorSupervisor(
    () => now,
    () =>
      new Promise<void>(resolve => {
        waits.push(resolve)
      }),
    () => {}
  )
  return {
    supervisor,
    advance(ms: number) {
      now += ms
    },
    /** Release every pending inter-pass wait. */
    async releaseWaits() {
      const pending = waits.splice(0)
      for (const r of pending) r()
      await flush()
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('MonitorSupervisor', () => {
  it('runs passes and stamps lastPassAt after each', async () => {
    const h = harness()
    const m = fakeMonitor(jest.fn().mockResolvedValue(undefined))
    h.supervisor.start(m as never)
    expect(m._tasksRunning).toBe(true)
    await flush()
    expect(m.runOnce).toHaveBeenCalledTimes(1)
    h.advance(30_000)
    await h.releaseWaits()
    expect(m.runOnce).toHaveBeenCalledTimes(2)
    expect(h.supervisor.isStalled()).toBe(false)
  })

  it('a pass that throws does not end the loop', async () => {
    const h = harness()
    const runOnce = jest.fn().mockRejectedValueOnce(new Error('logEvent failed')).mockResolvedValue(undefined)
    const m = fakeMonitor(runOnce)
    h.supervisor.start(m as never)
    await flush()
    await h.releaseWaits()
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it('reports a stall only after the threshold with no completed pass', async () => {
    const h = harness()
    let hang: () => void = () => {}
    const runOnce = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            hang = resolve
          })
      )
    const m = fakeMonitor(runOnce)
    h.supervisor.start(m as never)
    await flush()
    await h.releaseWaits() // second pass now hangs
    h.advance(MONITOR_STALL_MS - 1)
    expect(h.supervisor.isStalled()).toBe(false)
    h.advance(2)
    expect(h.supervisor.isStalled()).toBe(true)
    hang()
  })

  it('restart starts a new generation on the same monitor and the hung one exits when it wakes', async () => {
    const h = harness()
    let hang: () => void = () => {}
    const runOnce = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            hang = resolve
          })
      )
      .mockResolvedValue(undefined)
    const m = fakeMonitor(runOnce)
    h.supervisor.start(m as never)
    await flush()
    expect(runOnce).toHaveBeenCalledTimes(1)

    h.advance(MONITOR_STALL_MS + 1)
    expect(h.supervisor.isStalled()).toBe(true)
    expect(h.supervisor.restart()).toBe(true)
    expect(h.supervisor.restarts).toBe(1)
    expect(h.supervisor.isStalled()).toBe(false)
    await flush()
    // New generation ran a pass while the old one is still hung.
    expect(runOnce).toHaveBeenCalledTimes(2)

    // Old generation wakes up: must not run another pass.
    hang()
    await flush()
    await h.releaseWaits()
    // One wait belonged to the new generation → exactly one more pass, not two.
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('touch resets the stall clock (foreground resume)', () => {
    const h = harness()
    const m = fakeMonitor(jest.fn().mockImplementation(() => new Promise<void>(() => {})))
    h.supervisor.start(m as never)
    h.advance(MONITOR_STALL_MS + 1)
    expect(h.supervisor.isStalled()).toBe(true)
    h.supervisor.touch()
    expect(h.supervisor.isStalled()).toBe(false)
  })

  it('stopTasks ends the loop and resolves the drain promise; a stopped monitor never reads as stalled', async () => {
    const h = harness()
    const m = fakeMonitor(jest.fn().mockResolvedValue(undefined))
    h.supervisor.start(m as never)
    await flush()
    m.stopTasks()
    await h.releaseWaits()
    await expect(m._tasksRunningPromise).resolves.toBeUndefined()
    h.advance(MONITOR_STALL_MS * 2)
    expect(h.supervisor.isStalled()).toBe(false)
    expect(h.supervisor.restart()).toBe(false)
  })
})
