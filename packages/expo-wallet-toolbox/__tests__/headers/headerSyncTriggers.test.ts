import { HEADER_SYNC_INTERVAL_MS, startHeaderSyncTriggers } from '../../core/headers/headerSyncTriggers'

function harness(online = true) {
  let onlineCb: ((online: boolean) => void) | undefined
  let foregroundCb: (() => void) | undefined
  let tick: (() => void) | undefined
  const deps = {
    sync: jest.fn(async () => undefined),
    isOnline: jest.fn(async () => online),
    subscribeOnline: jest.fn((cb: (online: boolean) => void) => {
      onlineCb = cb
      return jest.fn()
    }),
    subscribeForeground: jest.fn((cb: () => void) => {
      foregroundCb = cb
      return jest.fn()
    }),
    setInterval: jest.fn((fn: () => void, _ms: number) => {
      tick = fn
      return 'handle'
    }),
    clearInterval: jest.fn()
  }
  const stop = startHeaderSyncTriggers(deps)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return {
    deps,
    stop,
    flush,
    goOnline: (value: boolean) => onlineCb!(value),
    foreground: () => foregroundCb!(),
    tick: () => tick!()
  }
}

describe('startHeaderSyncTriggers', () => {
  it('syncs when the device comes online, without re-asking whether it is online', async () => {
    const h = harness(false)
    h.goOnline(true)
    await h.flush()
    expect(h.deps.sync).toHaveBeenCalledTimes(1)
    expect(h.deps.isOnline).not.toHaveBeenCalled()
  })

  it('does nothing when NetInfo reports offline', async () => {
    const h = harness()
    h.goOnline(false)
    await h.flush()
    expect(h.deps.sync).not.toHaveBeenCalled()
  })

  it('syncs on returning to the foreground while online', async () => {
    const h = harness(true)
    h.foreground()
    await h.flush()
    expect(h.deps.sync).toHaveBeenCalledTimes(1)
  })

  it('syncs on every interval tick while online, at one block time by default', async () => {
    const h = harness(true)
    expect(h.deps.setInterval).toHaveBeenCalledWith(expect.any(Function), HEADER_SYNC_INTERVAL_MS)
    h.tick()
    h.tick()
    await h.flush()
    expect(h.deps.sync).toHaveBeenCalledTimes(2)
  })

  it('skips the foreground and interval passes while offline', async () => {
    const h = harness(false)
    h.foreground()
    h.tick()
    await h.flush()
    expect(h.deps.sync).not.toHaveBeenCalled()
  })

  it('swallows a failed sync so the next trigger can retry', async () => {
    const h = harness(true)
    h.deps.sync.mockRejectedValueOnce(new Error('network'))
    h.tick()
    await h.flush()
    h.tick()
    await h.flush()
    expect(h.deps.sync).toHaveBeenCalledTimes(2)
  })

  it('stop() unsubscribes everything and ignores late triggers', async () => {
    const h = harness(true)
    h.stop()
    expect(h.deps.subscribeOnline.mock.results[0].value).toHaveBeenCalled()
    expect(h.deps.subscribeForeground.mock.results[0].value).toHaveBeenCalled()
    expect(h.deps.clearInterval).toHaveBeenCalledWith('handle')
    h.tick()
    h.foreground()
    h.goOnline(true)
    await h.flush()
    expect(h.deps.sync).not.toHaveBeenCalled()
  })
})
