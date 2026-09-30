import { syncPushRegistration, PUSH_REGISTRATION_KEY } from '../../core/push/registration'
import type { PushAdapter } from '../../core/push/types'

const mem = () => {
  const m = new Map<string, string>()
  return {
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
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

describe('syncPushRegistration', () => {
  it('registers and caches the marker', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({ status: 'success' })
    const r = await syncPushRegistration({
      adapter: adapter(),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice }),
      storage
    })
    expect(r).toBe('registered')
    expect(registerDevice).toHaveBeenCalledWith({ fcmToken: 'tok1', platform: 'ios' }, HOST)
    expect(storage.m.get(PUSH_REGISTRATION_KEY)).toBe(`${HOST}|${ID}|tok1`)
  })
  it('is unchanged on a second call', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    const args = { adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage }
    await syncPushRegistration(args)
    expect(await syncPushRegistration(args)).toBe('unchanged')
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })
  it('re-registers when token changes', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    await syncPushRegistration({
      adapter: adapter(),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice }),
      storage
    })
    const r = await syncPushRegistration({
      adapter: adapter({ getToken: async () => 'tok2' }),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice }),
      storage
    })
    expect(r).toBe('registered')
  })
  it('re-registers when identity changes', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    await syncPushRegistration({
      adapter: adapter(),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice }),
      storage
    })
    const r = await syncPushRegistration({
      adapter: adapter(),
      host: HOST,
      identityKey: '03'.padEnd(66, 'b'),
      makeClient: () => ({ registerDevice }),
      storage
    })
    expect(r).toBe('registered')
  })
  it('skips when permission not granted', async () => {
    const registerDevice = jest.fn()
    const r = await syncPushRegistration({
      adapter: adapter({ getPermission: async () => 'denied' }),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice }),
      storage: mem()
    })
    expect(r).toBe('skipped')
    expect(registerDevice).not.toHaveBeenCalled()
  })
  it('skips without adapter or host', async () => {
    const makeClient = jest.fn()
    expect(
      await syncPushRegistration({ adapter: undefined, host: HOST, identityKey: ID, makeClient, storage: mem() })
    ).toBe('skipped')
    expect(
      await syncPushRegistration({ adapter: adapter(), host: undefined, identityKey: ID, makeClient, storage: mem() })
    ).toBe('skipped')
    expect(makeClient).not.toHaveBeenCalled()
  })
  it('does not cache on failure', async () => {
    const storage = mem()
    const r = await syncPushRegistration({
      adapter: adapter(),
      host: HOST,
      identityKey: ID,
      makeClient: () => ({ registerDevice: jest.fn().mockRejectedValue(new Error('503')) }),
      storage
    })
    expect(r).toBe('failed')
    expect(storage.m.has(PUSH_REGISTRATION_KEY)).toBe(false)
  })
})
