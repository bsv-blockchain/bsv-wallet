import { isOnlineState, probeOnline } from '../../core/net/online'

describe('isOnlineState', () => {
  it('is online when connected and reachability is unknown', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true)
  })

  it('is online when connected and reachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connected but explicitly unreachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false)
  })

  it('is offline when not connected', () => {
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false)
  })

  // Cold start: NetInfo has not answered yet. Announcing "offline" here is
  // what put the offline banner in front of users who had signal all along.
  it('is not offline merely because connectivity is not known yet', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(true)
    expect(isOnlineState({ isConnected: null, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connectivity is unknown but reachability is explicitly false', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: false })).toBe(false)
  })
})

/**
 * NetInfo's verdict is a cached snapshot (iOS reachability callbacks do not
 * fire while the app is suspended) plus, on iOS, an HTTP probe of a Google
 * host the wallet has no other use for. `probeOnline` is the live request that
 * settles a disagreement: it asks the hosts the wallet itself depends on.
 */
describe('probeOnline', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.useRealTimers()
  })

  it('is online when any host answers, whatever the status', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ status: 404 }) as unknown as typeof fetch
    await expect(probeOnline()).resolves.toBe(true)
  })

  it('is offline when every host fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as unknown as typeof fetch
    await expect(probeOnline()).resolves.toBe(false)
  })

  it('is offline when nothing answers within the budget', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    ) as unknown as typeof fetch
    const result = probeOnline(1000)
    await jest.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toBe(false)
  })

  it('asks with HEAD, without cookies or caching', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    await probeOnline()
    expect(fetchMock).toHaveBeenCalled()
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', cache: 'no-store' })
    }
  })
})
