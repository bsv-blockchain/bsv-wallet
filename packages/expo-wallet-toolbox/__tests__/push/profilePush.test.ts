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
  /** Profiles that were removed, as opposed to merely not wanted by this build. */
  removed: Set<number>
  hosts: Record<number, string | undefined>
}

function harness(over: Partial<ProfilePushDeps> = {}, activeIndex = 0): Harness {
  const storage = mem()
  const registered: Harness['registered'] = []
  const posted: Harness['posted'] = []
  const current = new Set([0, 1, 2])
  const removed = new Set<number>()
  const hosts: Harness['hosts'] = { 0: HOST, 1: 'https://one.example.org', 2: HOST }
  const push = createProfilePush({
    adapter: adapter(),
    profiles: [profile(0), profile(1), profile(2)],
    activeIndex,
    readHost: async index => hosts[index],
    isCurrent: index => current.has(index),
    isRemoved: index => removed.has(index),
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
  return { push, storage, registered, posted, current, removed, hosts }
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

    it('leaves the marker of an identity this build holds no wallet for, so a build that has its key can withdraw it', async () => {
      const h = harness()
      const stranger = '03'.padEnd(66, 'e')
      h.storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [stranger]: `${HOST}|tok1` }))
      await h.push.unregister([stranger])
      expect(h.posted).toEqual([])
      expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).toEqual({ [stranger]: `${HOST}|tok1` })
    })

    it('keeps the marker of a profile whose withdrawal failed', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const h = harness({ makePost: () => async () => ({ status: 503 }) })
        await h.push.sync()
        await h.push.unregister([ID[1]])
        expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)[ID[1]]).toBe('https://one.example.org|tok1')
      } finally {
        warn.mockRestore()
      }
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

  describe('a registration in flight when its profile is removed', () => {
    it('withdraws it as that profile, instead of remembering it', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        let answer!: () => void
        let h!: Harness
        h = harness({
          makeClient: (wallet, host) => ({
            registerDevice: async () => {
              h.registered.push({ wallet, host })
              if ((wallet as { wallet: number }).wallet !== 1) return {}
              await new Promise<void>(resolve => (answer = resolve))
              return {}
            }
          })
        })
        const run = h.push.sync()
        for (let i = 0; i < 50 && !answer; i++) await new Promise(r => setImmediate(r))
        // The removal tombstones the profile and withdraws what it has registered, which is nothing yet.
        h.current.delete(1)
        h.removed.add(1)
        await h.push.unregister([ID[1]])
        expect(h.posted).toEqual([])
        answer()
        await run
        expect(h.posted).toEqual([
          { wallet: { wallet: 1 }, url: 'https://one.example.org/unregisterDevice', token: 'tok1' }
        ])
        expect(Object.keys(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).sort()).toEqual([ID[0], ID[2]].sort())
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('retired profiles', () => {
    const retiredDeps = (): Partial<ProfilePushDeps> => ({ retired: [profile(2)], profiles: [profile(0), profile(1)] })

    it('withdraws the registration a removed profile still has, signed as it, and forgets the marker', async () => {
      const h = harness(retiredDeps())
      h.storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID[2]]: `${HOST}|oldtok` }))
      await h.push.sync()
      expect(h.posted).toEqual([{ wallet: { wallet: 2 }, url: `${HOST}/unregisterDevice`, token: 'oldtok' }])
      expect(Object.keys(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).sort()).toEqual([ID[0], ID[1]].sort())
    })

    it('Delete Wallet withdraws a retired profile’s registration too: it is the last time anything can sign as it', async () => {
      const h = harness(retiredDeps())
      h.storage.m.set(
        PUSH_REGISTRATION_KEY,
        JSON.stringify({ [ID[2]]: `${HOST}|oldtok`, [ID[1]]: 'https://one.example.org|oldtok' })
      )
      await h.push.unregister()
      expect(h.posted.map(p => [(p.wallet as { wallet: number }).wallet, p.url, p.token]).sort()).toEqual([
        [1, 'https://one.example.org/unregisterDevice', 'oldtok'],
        [2, `${HOST}/unregisterDevice`, 'oldtok']
      ])
      expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).toEqual({})
    })

    it('never registers one, and never routes a tap to one', async () => {
      const h = harness(retiredDeps())
      await h.push.sync()
      expect(walletsOf(h)).toEqual([1, 0])
      expect(h.push.inactiveProfileFor(ID[2])).toBeUndefined()
    })

    it('asks nothing for a retired profile with no registration left', async () => {
      const h = harness(retiredDeps())
      await h.push.sync()
      expect(h.posted).toEqual([])
    })

    it('tries again at the next sync when the server did not answer', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        let status = 503
        const h = harness({
          ...retiredDeps(),
          makePost: wallet => async (url, body) => {
            h.posted.push({ wallet, url, token: body.fcmToken })
            return { status }
          }
        })
        h.storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID[2]]: `${HOST}|oldtok` }))
        await h.push.sync()
        expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)[ID[2]]).toBe(`${HOST}|oldtok`)
        status = 200
        await h.push.sync()
        expect(h.posted).toHaveLength(2)
        expect(JSON.parse(h.storage.m.get(PUSH_REGISTRATION_KEY)!)).not.toHaveProperty(ID[2])
        await h.push.sync()
        expect(h.posted).toHaveLength(2)
      } finally {
        warn.mockRestore()
      }
    })

    it('still registers the live profiles when withdrawing a retired one throws', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const h = harness({
          ...retiredDeps(),
          makePost: wallet => {
            if ((wallet as { wallet: number }).wallet === 2) throw new Error('no wallet')
            return async () => ({ status: 200 })
          }
        })
        h.storage.m.set(PUSH_REGISTRATION_KEY, JSON.stringify({ [ID[2]]: `${HOST}|oldtok` }))
        await expect(h.push.sync()).resolves.toBeUndefined()
        expect(walletsOf(h)).toEqual([1, 0])
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
