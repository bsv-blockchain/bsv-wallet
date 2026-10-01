import {
  forgetPushMarker,
  PUSH_REGISTRATION_KEY,
  PUSH_REGISTRATION_OWNER_KEY,
  PUSH_UNREGISTER_TIMEOUT_MS,
  syncPushRegistrations,
  unregisterPushIdentity,
  type PushPost,
  type PushTarget,
  type RegisterDeviceClient
} from '../../core/push/registration'
import type { PushAdapter } from '../../core/push/types'

const mem = () => {
  const m = new Map<string, string>()
  return {
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
    m
  }
}
const adapter = (over: Partial<PushAdapter> = {}): PushAdapter =>
  ({
    platform: 'ios',
    getPermission: async () => 'granted',
    getToken: async () => 'tok1',
    ...over
  }) as PushAdapter
const HOST = 'https://messagebox.bsvblockchain.tech'
const ID = '02'.padEnd(66, 'a')
const ID_B = '03'.padEnd(66, 'b')
const ID_C = '03'.padEnd(66, 'c')

/** A target whose client records every registration into `calls`, in order. */
function target(
  index: number,
  identityKey: string,
  calls: Array<{ index: number; host: string; token: string }>,
  over: Partial<PushTarget> = {}
): PushTarget {
  return {
    index,
    identityKey,
    host: HOST,
    makeClient: (host): RegisterDeviceClient => ({
      registerDevice: async params => {
        calls.push({ index, host, token: params.fcmToken })
        return { status: 'success' }
      }
    }),
    ...over
  }
}
const markers = (storage: ReturnType<typeof mem>) => JSON.parse(storage.m.get(PUSH_REGISTRATION_KEY) ?? '{}')

describe('syncPushRegistrations', () => {
  it('registers and keeps a marker per identity', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({ status: 'success' })
    const r = await syncPushRegistrations({
      adapter: adapter(),
      targets: [{ index: 0, identityKey: ID, host: HOST, active: true, makeClient: () => ({ registerDevice }) }],
      storage
    })
    expect(r).toEqual([{ index: 0, result: 'registered' }])
    expect(registerDevice).toHaveBeenCalledWith({ fcmToken: 'tok1', platform: 'ios' }, HOST)
    expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok1` })
  })

  it('registers every profile, inactive ones first and the active one last, whatever order they are given in', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(1, ID_B, calls, { active: true }), target(2, ID_C, calls), target(0, ID, calls)],
      storage
    })
    expect(calls.map(c => c.index)).toEqual([0, 2, 1])
    expect(r.map(x => x.index)).toEqual([0, 2, 1])
    expect(markers(storage)).toEqual({
      [ID]: `${HOST}|tok1`,
      [ID_B]: `${HOST}|tok1`,
      [ID_C]: `${HOST}|tok1`
    })
    expect(storage.m.get(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID_B)
  })

  it('is unchanged on a second call', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    const targets = [target(0, ID, calls, { active: true }), target(1, ID_B, calls)]
    await syncPushRegistrations({ adapter: adapter(), targets, storage })
    expect(calls).toHaveLength(2)
    const r = await syncPushRegistrations({ adapter: adapter(), targets, storage })
    expect(r.map(x => x.result)).toEqual(['unchanged', 'unchanged'])
    expect(calls).toHaveLength(2)
  })

  it('re-registers every profile when the token changes', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    const targets = [target(0, ID, calls, { active: true }), target(1, ID_B, calls)]
    await syncPushRegistrations({ adapter: adapter(), targets, storage })
    const r = await syncPushRegistrations({ adapter: adapter({ getToken: async () => 'tok2' }), targets, storage })
    expect(r.map(x => x.result)).toEqual(['registered', 'registered'])
    expect(calls.slice(2)).toEqual([
      { index: 1, host: HOST, token: 'tok2' },
      { index: 0, host: HOST, token: 'tok2' }
    ])
    expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok2`, [ID_B]: `${HOST}|tok2` })
  })

  it('re-registers a profile whose host changed, then the active one so it still owns the token', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls)],
      storage
    })
    calls.length = 0
    const other = 'https://mb.example.org'
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls, { host: other })],
      storage
    })
    // Profile 1 re-registers at its new host, and the active profile registers after it so
    // that a one-identity-per-token server leaves the token with the profile in use.
    expect(calls).toEqual([
      { index: 1, host: other, token: 'tok1' },
      { index: 0, host: HOST, token: 'tok1' }
    ])
    expect(markers(storage)[ID_B]).toBe(`${other}|tok1`)
  })

  it('registers only the profile that is new, then the active one again so it still owns the token', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls)],
      storage
    })
    calls.length = 0
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls), target(2, ID_C, calls)],
      storage
    })
    expect(calls.map(c => c.index)).toEqual([2, 0])
    expect(storage.m.get(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID)
  })

  describe('against a server that keeps one identity per token', () => {
    it('a profile that becomes active registers again even though its own marker is intact', async () => {
      const storage = mem()
      const calls: Array<{ index: number; host: string; token: string }> = []
      const asActive = (active: number) => [
        target(0, ID, calls, { active: active === 0 }),
        target(1, ID_B, calls, { active: active === 1 })
      ]
      await syncPushRegistrations({ adapter: adapter(), targets: asActive(0), storage })
      expect(calls.map(c => c.index)).toEqual([1, 0])
      calls.length = 0

      // Switch to profile 1: the old server gave the token to profile 0 (registered last).
      await syncPushRegistrations({ adapter: adapter(), targets: asActive(1), storage })
      expect(calls.map(c => c.index)).toEqual([1])
      expect(storage.m.get(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID_B)
      calls.length = 0

      // And back.
      await syncPushRegistrations({ adapter: adapter(), targets: asActive(0), storage })
      expect(calls.map(c => c.index)).toEqual([0])

      // Nothing more to say once the active profile is the owner.
      calls.length = 0
      await syncPushRegistrations({ adapter: adapter(), targets: asActive(0), storage })
      expect(calls).toEqual([])
    })
  })

  it('skips a profile with no MessageBox host and still registers the others', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls, { host: undefined })],
      storage
    })
    expect(r).toEqual([
      { index: 1, result: 'skipped' },
      { index: 0, result: 'registered' }
    ])
    expect(calls.map(c => c.index)).toEqual([0])
    expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok1` })
  })

  it('each profile registers at its own host', async () => {
    const calls: Array<{ index: number; host: string; token: string }> = []
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls, { host: 'https://mb.example.org' })],
      storage: mem()
    })
    expect(calls).toEqual([
      { index: 1, host: 'https://mb.example.org', token: 'tok1' },
      { index: 0, host: HOST, token: 'tok1' }
    ])
  })

  it('a profile whose registration fails does not stop the others, and is retried next time', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = mem()
      const calls: Array<{ index: number; host: string; token: string }> = []
      const flaky = target(1, ID_B, calls, {
        makeClient: () => ({ registerDevice: jest.fn().mockRejectedValue(new Error('503')) })
      })
      const r = await syncPushRegistrations({
        adapter: adapter(),
        targets: [target(0, ID, calls, { active: true }), flaky],
        storage
      })
      expect(r).toEqual([
        { index: 1, result: 'failed' },
        { index: 0, result: 'registered' }
      ])
      expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok1` })

      const again = await syncPushRegistrations({
        adapter: adapter(),
        targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls)],
        storage
      })
      expect(again.find(x => x.index === 1)?.result).toBe('registered')
    } finally {
      warn.mockRestore()
    }
  })

  it('drops a profile that stopped being current before its turn, without a call', async () => {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls, { isCurrent: () => false })],
      storage
    })
    expect(r).toEqual([
      { index: 1, result: 'skipped' },
      { index: 0, result: 'registered' }
    ])
    expect(calls.map(c => c.index)).toEqual([0])
    expect(markers(storage)).not.toHaveProperty(ID_B)
  })

  it('treats a marker in the old single-slot format as nothing registered', async () => {
    const storage = mem()
    storage.m.set(PUSH_REGISTRATION_KEY, `${HOST}|${ID}|tok1`)
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true })],
      storage
    })
    expect(r).toEqual([{ index: 0, result: 'registered' }])
    expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok1` })
  })

  it('skips everything when permission is not granted', async () => {
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter({ getPermission: async () => 'denied' }),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls)],
      storage: mem()
    })
    expect(r.map(x => x.result)).toEqual(['skipped', 'skipped'])
    expect(calls).toEqual([])
  })

  it('skips everything when there is no token', async () => {
    const calls: Array<{ index: number; host: string; token: string }> = []
    const r = await syncPushRegistrations({
      adapter: adapter({ getToken: async () => null }),
      targets: [target(0, ID, calls, { active: true })],
      storage: mem()
    })
    expect(r).toEqual([{ index: 0, result: 'skipped' }])
    expect(calls).toEqual([])
  })

  it('skips without an adapter, without a host, or without targets', async () => {
    const makeClient = jest.fn()
    const base = { index: 0, identityKey: ID, active: true, makeClient }
    expect(
      await syncPushRegistrations({ adapter: undefined, targets: [{ ...base, host: HOST }], storage: mem() })
    ).toEqual([{ index: 0, result: 'skipped' }])
    expect(
      await syncPushRegistrations({ adapter: adapter(), targets: [{ ...base, host: undefined }], storage: mem() })
    ).toEqual([{ index: 0, result: 'skipped' }])
    expect(await syncPushRegistrations({ adapter: adapter(), targets: [], storage: mem() })).toEqual([])
    expect(makeClient).not.toHaveBeenCalled()
  })

  describe('on failure', () => {
    let warn: jest.SpyInstance
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
    })
    const single = (registerDevice: jest.Mock, a: PushAdapter = adapter(), storage = mem()) =>
      syncPushRegistrations({
        adapter: a,
        targets: [{ index: 0, identityKey: ID, host: HOST, active: true, makeClient: () => ({ registerDevice }) }],
        storage
      })

    it('does not cache, and says why without the token', async () => {
      const storage = mem()
      const r = await single(jest.fn().mockRejectedValue(new Error('503')), adapter(), storage)
      expect(r).toEqual([{ index: 0, result: 'failed' }])
      expect(storage.m.has(PUSH_REGISTRATION_KEY)).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toBe('[push] registerDevice failed: 503')
      expect(line).not.toContain('tok1')
      expect(line).not.toContain(ID)
      expect(line).not.toContain(HOST)
    })

    it('cuts the token, identity key and host out of a message that quotes them', async () => {
      const r = await single(
        jest.fn().mockRejectedValue(new Error(`POST ${HOST}/registerDevice for ${ID} with tok1 -> 502`))
      )
      expect(r).toEqual([{ index: 0, result: 'failed' }])
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('[push] registerDevice failed: ')
      expect(line).toContain('502')
      expect(line).not.toContain('tok1')
      expect(line).not.toContain(ID)
      expect(line).not.toContain(HOST)
    })

    it('still never throws when the adapter itself fails', async () => {
      const r = await single(
        jest.fn(),
        adapter({
          getToken: async () => {
            throw new Error('fcm unavailable')
          }
        })
      )
      expect(r).toEqual([{ index: 0, result: 'failed' }])
      expect(warn).toHaveBeenCalledWith('[push] registerDevice failed: fcm unavailable')
    })

    it('a storage that fails is a failed target, not a throw', async () => {
      const storage = {
        ...mem(),
        getItem: async () => {
          throw new Error('disk full')
        }
      }
      const r = await single(jest.fn(), adapter(), storage as never)
      expect(r).toEqual([{ index: 0, result: 'failed' }])
      expect(warn).toHaveBeenCalledWith('[push] registerDevice failed: disk full')
    })
  })
})

describe('unregisterPushIdentity', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  /** Storage after both profiles registered: B holds the markers' owner slot. */
  async function registered() {
    const storage = mem()
    const calls: Array<{ index: number; host: string; token: string }> = []
    await syncPushRegistrations({
      adapter: adapter(),
      targets: [target(0, ID, calls, { active: true }), target(1, ID_B, calls)],
      storage
    })
    return storage
  }
  const post = (status = 200): jest.MockedFunction<PushPost> =>
    jest.fn(async (_url: string, _body: { fcmToken: string }) => ({ status }))

  it('asks the host the identity registered at, with the token it registered, and forgets the marker', async () => {
    const storage = await registered()
    const send = post()
    expect(await unregisterPushIdentity({ identityKey: ID_B, post: send, storage })).toBe('unregistered')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(`${HOST}/unregisterDevice`, { fcmToken: 'tok1' })
    expect(markers(storage)).toEqual({ [ID]: `${HOST}|tok1` })
  })

  it('uses the recorded host and token even when the device has moved on since', async () => {
    const storage = await registered()
    storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID_B]: 'https://mb.example.org/box/|oldtok' }))
    const send = post()
    await unregisterPushIdentity({ identityKey: ID_B, post: send, storage })
    expect(send).toHaveBeenCalledWith('https://mb.example.org/box/unregisterDevice', { fcmToken: 'oldtok' })
  })

  it('clears the owner record when it was the owner, and leaves it when it was not', async () => {
    const storage = await registered()
    expect(storage.m.get(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID)
    await unregisterPushIdentity({ identityKey: ID_B, post: post(), storage })
    expect(storage.m.get(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID)
    await unregisterPushIdentity({ identityKey: ID, post: post(), storage })
    expect(storage.m.has(PUSH_REGISTRATION_OWNER_KEY)).toBe(false)
  })

  it('does nothing for an identity this device never registered', async () => {
    const storage = await registered()
    const before = storage.m.get(PUSH_REGISTRATION_KEY)
    const send = post()
    expect(await unregisterPushIdentity({ identityKey: ID_C, post: send, storage })).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
    expect(storage.m.get(PUSH_REGISTRATION_KEY)).toBe(before)
  })

  it.each([404, 405, 501])(
    'tolerates an old server answering %d: unsupported, quietly, marker forgotten',
    async status => {
      const storage = await registered()
      expect(await unregisterPushIdentity({ identityKey: ID_B, post: post(status), storage })).toBe('unsupported')
      expect(warn).not.toHaveBeenCalled()
      expect(markers(storage)).not.toHaveProperty(ID_B)
    }
  )

  it('a server error is a failure that is logged, and still forgets the marker', async () => {
    const storage = await registered()
    expect(await unregisterPushIdentity({ identityKey: ID_B, post: post(500), storage })).toBe('failed')
    expect(warn).toHaveBeenCalledWith('[push] unregisterDevice failed: HTTP 500')
    expect(markers(storage)).not.toHaveProperty(ID_B)
  })

  it('a request that throws is contained and logged without the token, identity key or host', async () => {
    const storage = await registered()
    const send = jest.fn().mockRejectedValue(new Error(`${HOST}/unregisterDevice ${ID_B} tok1 refused`))
    expect(await unregisterPushIdentity({ identityKey: ID_B, post: send, storage })).toBe('failed')
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain('[push] unregisterDevice failed: ')
    expect(line).toContain('refused')
    for (const secret of ['tok1', ID_B, HOST]) expect(line).not.toContain(secret)
    expect(markers(storage)).not.toHaveProperty(ID_B)
  })

  it('refuses a host it would not talk to, without sending anything', async () => {
    const storage = await registered()
    storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID_B]: 'http://mb.example.org|tok1' }))
    const send = post()
    expect(await unregisterPushIdentity({ identityKey: ID_B, post: send, storage })).toBe('failed')
    expect(send).not.toHaveBeenCalled()
  })

  it('allows plain HTTP on loopback, for a local server', async () => {
    const storage = await registered()
    storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID_B]: 'http://localhost:8080|tok1' }))
    const send = post()
    expect(await unregisterPushIdentity({ identityKey: ID_B, post: send, storage })).toBe('unregistered')
    expect(send).toHaveBeenCalledWith('http://localhost:8080/unregisterDevice', { fcmToken: 'tok1' })
  })

  describe('a server that never answers', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it('is given up on after the timeout, which leaves no timer behind', async () => {
      const storage = await registered()
      const hang: PushPost = () => new Promise(() => {})
      const p = unregisterPushIdentity({ identityKey: ID_B, post: hang, storage })
      await jest.advanceTimersByTimeAsync(PUSH_UNREGISTER_TIMEOUT_MS)
      expect(await p).toBe('failed')
      expect(warn).toHaveBeenCalledWith('[push] unregisterDevice failed: timed out')
      expect(markers(storage)).not.toHaveProperty(ID_B)
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  it("concurrent unregisters and registrations do not lose each other's marker updates", async () => {
    const storage = await registered()
    const calls: Array<{ index: number; host: string; token: string }> = []
    await Promise.all([
      unregisterPushIdentity({ identityKey: ID_B, post: post(), storage }),
      syncPushRegistrations({
        adapter: adapter(),
        targets: [target(0, ID, calls, { active: true }), target(2, ID_C, calls)],
        storage
      }),
      forgetPushMarker('04'.padEnd(66, 'd'), storage)
    ])
    const m = markers(storage)
    expect(m).not.toHaveProperty(ID_B)
    expect(m[ID]).toBe(`${HOST}|tok1`)
    expect(m[ID_C]).toBe(`${HOST}|tok1`)
  })
})
