import { createProfilePush, type ProfilePushDeps } from '../../core/push/profilePush'
import type { PushProfile } from '../../core/push/identities'
import { PUSH_REGISTRATION_KEY } from '../../core/push/registration'
import type { PushAdapter } from '../../core/push/types'

const HOST = 'https://messagebox.bsvblockchain.tech'
const ID = ['02'.padEnd(66, 'a'), '03'.padEnd(66, 'b'), '03'.padEnd(66, 'c')]
const profile = (index: number): PushProfile => ({ index, identityKey: ID[index], wallet: { wallet: index } })

const mem = () => {
  const m = new Map<string, string>()
  return {
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
    m
  }
}
const adapter = (): PushAdapter =>
  ({ platform: 'android', getPermission: async () => 'granted', getToken: async () => 'tok1' }) as PushAdapter

interface Harness {
  push: ReturnType<typeof createProfilePush>
  storage: ReturnType<typeof mem>
  registered: Array<{ wallet: unknown; host: string }>
  posted: Array<{ wallet: unknown; url: string; token: string }>
  current: Set<number>
  hosts: Record<number, string | undefined>
}

function harness(over: Partial<ProfilePushDeps> = {}, activeIndex = 0): Harness {
  const storage = mem()
  const registered: Harness['registered'] = []
  const posted: Harness['posted'] = []
  const current = new Set([0, 1, 2])
  const hosts: Harness['hosts'] = { 0: HOST, 1: 'https://one.example.org', 2: HOST }
  const push = createProfilePush({
    adapter: adapter(),
    profiles: [profile(0), profile(1), profile(2)],
    activeIndex,
    readHost: async index => hosts[index],
    isCurrent: index => current.has(index),
    makeClient: (wallet, host) => ({
      registerDevice: async () => {
        registered.push({ wallet, host })
        return {}
      }
    }),
    makePost: wallet => async (url, body) => {
      posted.push({ wallet, url, token: body.fcmToken })
      return { status: 200 }
    },
    storage,
    ...over
  })
  return { push, storage, registered, posted, current, hosts }
}
const walletsOf = (h: Harness) => h.registered.map(r => (r.wallet as { wallet: number }).wallet)

describe('createProfilePush', () => {
  describe('sync', () => {
    it('registers every live profile as itself at its own host, the open one last', async () => {
      const h = harness({}, 1)
      await h.push.sync()
      expect(walletsOf(h)).toEqual([0, 2, 1])
      expect(h.registered.map(r => r.host)).toEqual([HOST, HOST, 'https://one.example.org'])
      expect(Object.keys(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).sort()).toEqual([...ID].sort())
    })

    it('leaves out a profile that was removed, even if a build still holds its key', async () => {
      const h = harness({}, 0)
      h.current.delete(1)
      await h.push.sync()
      expect(walletsOf(h)).toEqual([2, 0])
    })

    it('registers nothing for a build that was replaced', async () => {
      const h = harness()
      h.current.clear()
      await h.push.sync()
      expect(h.registered).toEqual([])
    })

    it('stops registering the profiles still to come when the build is replaced mid-run', async () => {
      let h!: Harness
      h = harness({
        makeClient: (wallet, host) => ({
          registerDevice: async () => {
            h.registered.push({ wallet, host })
            h.current.clear()
            return {}
          }
        })
      })
      await h.push.sync()
      expect(h.registered).toHaveLength(1)
    })

    it('does nothing without a push adapter', async () => {
      const h = harness({ adapter: undefined })
      await h.push.sync()
      expect(h.registered).toEqual([])
    })

    it('a profile whose host cannot be read is skipped and the rest still register', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const h = harness({
          readHost: async index => {
            if (index === 1) throw new Error('storage unavailable')
            return HOST
          }
        })
        await h.push.sync()
        expect(walletsOf(h)).toEqual([2, 0])
        expect(warn).toHaveBeenCalledWith('[push] could not read the MessageBox host: storage unavailable')
      } finally {
        warn.mockRestore()
      }
    })

    it('a second sync with nothing changed makes no request', async () => {
      const h = harness()
      await h.push.sync()
      h.registered.length = 0
      await h.push.sync()
      expect(h.registered).toEqual([])
    })

    it('overlapping triggers fold into one run at a time', async () => {
      const h = harness()
      await Promise.all([h.push.sync(), h.push.sync(), h.push.sync()])
      // First run registers all three; the folded rerun finds everything unchanged.
      expect(h.registered).toHaveLength(3)
    })
  })

  describe('unregister', () => {
    it('withdraws only the identities asked for, each signed as itself, from the host it registered at', async () => {
      const h = harness()
      await h.push.sync()
      await h.push.unregister([ID[1]])
      expect(h.posted).toEqual([
        { wallet: { wallet: 1 }, url: 'https://one.example.org/unregisterDevice', token: 'tok1' }
      ])
      const left = Object.keys(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!))
      expect(left.sort()).toEqual([ID[0], ID[2]].sort())
    })

    it('withdraws every profile of the build when none are named', async () => {
      const h = harness()
      await h.push.sync()
      await h.push.unregister()
      expect(h.posted.map(p => (p.wallet as { wallet: number }).wallet).sort()).toEqual([0, 1, 2])
      expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).toEqual({})
    })

    it('forgets the marker of an identity this build holds no wallet for, without a request', async () => {
      const h = harness()
      const stranger = '03'.padEnd(66, 'e')
      h.storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [stranger]: `${HOST}|tok1` }))
      await h.push.unregister([stranger])
      expect(h.posted).toEqual([])
      expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).toEqual({})
    })

    it('does nothing for a profile that never registered', async () => {
      const h = harness()
      await h.push.unregister()
      expect(h.posted).toEqual([])
    })

    it('never rejects, whatever the request does', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const h = harness({
          makePost: () => {
            throw new Error('no wallet')
          }
        })
        await h.push.sync()
        await expect(h.push.unregister()).resolves.toBeUndefined()
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('inactiveProfileFor', () => {
    it('names the live profile, other than the open one, that an identity key belongs to', () => {
      const h = harness({}, 0)
      expect(h.push.inactiveProfileFor(ID[1])).toBe(1)
      expect(h.push.inactiveProfileFor(ID[2])).toBe(2)
    })

    it('compares the key regardless of case', () => {
      const h = harness({}, 0)
      expect(h.push.inactiveProfileFor(ID[1].toUpperCase())).toBe(1)
    })

    it('says nothing for the open profile, for a stranger, or for a profile that was removed', () => {
      const h = harness({}, 0)
      expect(h.push.inactiveProfileFor(ID[0])).toBeUndefined()
      expect(h.push.inactiveProfileFor('03'.padEnd(66, 'f'))).toBeUndefined()
      h.current.delete(2)
      expect(h.push.inactiveProfileFor(ID[2])).toBeUndefined()
    })

    it('follows the build: the profile that is open here is never inactive', () => {
      const h = harness({}, 1)
      expect(h.push.inactiveProfileFor(ID[1])).toBeUndefined()
      expect(h.push.inactiveProfileFor(ID[0])).toBe(0)
    })
  })
})
