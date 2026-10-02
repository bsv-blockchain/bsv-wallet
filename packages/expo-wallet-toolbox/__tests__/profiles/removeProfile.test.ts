/**
 * Removing a profile: the ordering and every abort path.
 *
 * The orchestrator runs against the REAL profile store, so the store's own
 * rules (the active profile and profile 0 cannot be tombstoned) are exercised
 * rather than assumed. Everything that needs a device — the open database, the
 * registry, the switch itself — is a scripted dependency that records what it
 * was asked, in order.
 *
 * What must hold: nothing is changed on this device until the switch to profile
 * 0 has landed, and every refusal before that leaves the store exactly as it
 * was.
 */
import {
  __resetProfilesForTests,
  appendProfile,
  getActiveProfileIndex,
  getProfilesState,
  setActiveProfile,
  updateProfile
} from '../../core/profiles/profileStore'
import {
  checkProfileRemoval,
  HANDLE_RELEASE_TIMEOUT_MS,
  removeProfileFlow,
  type HandleLookup,
  type RemoveProfileDeps
} from '../../core/profiles/removeProfile'
import type { ProfileEmptyResult } from '../../core/profiles/assertProfileEmpty'
import type { RegistrationResult } from '../../core/identity/handleRegistry/registration'

const IDENTITY = '02' + 'ab'.repeat(32)
const PAYMAIL = 'dee@deggen.com'

interface Script {
  supported: boolean
  ready: boolean
  online: boolean
  liveIdentityKey: string | undefined
  settled: boolean
  /** What each successive emptiness check answers; the last one repeats. */
  empty: ProfileEmptyResult[]
  /** The databases once the profile's own wallet is down. */
  closed: ProfileEmptyResult
  lookup: HandleLookup
  release: RegistrationResult
  switchLands: boolean
  /** Whether a landed switch also moves the store, as the real one does. */
  switchMovesStore: boolean
}

let calls: string[]
/** The identity each emptiness check was asked about. */
let checked: string[]
let script: Script

function makeDeps(index: number): RemoveProfileDeps {
  return {
    index,
    supported: script.supported,
    activeIndex: () => getActiveProfileIndex(),
    record: () => getProfilesState().profiles[index],
    ready: () => script.ready,
    online: async () => {
      calls.push('online')
      return script.online
    },
    liveIdentityKey: async () => {
      calls.push('liveIdentityKey')
      return script.liveIdentityKey
    },
    settleHandleJournal: async () => {
      calls.push('settleHandleJournal')
      return script.settled
    },
    checkEmpty: async identityKey => {
      calls.push('checkEmpty')
      checked.push(identityKey)
      return script.empty[Math.min(checked.length - 1, script.empty.length - 1)]
    },
    checkClosed: async identityKey => {
      calls.push(`checkClosed:${identityKey}`)
      return script.closed
    },
    lookupHandle: async identityKey => {
      calls.push(`lookupHandle:${identityKey}`)
      return script.lookup
    },
    releaseHandle: async paymail => {
      calls.push(`releaseHandle:${paymail}`)
      return script.release
    },
    switchToDefault: async () => {
      calls.push('switchToDefault')
      if (script.switchLands && script.switchMovesStore) await setActiveProfile(0)
      return script.switchLands
    },
    tombstone: async identityKey => {
      calls.push(`tombstone:${identityKey}`)
      await updateProfile(index, { deleted: true, identityKey })
    },
    purge: async target => {
      calls.push(`purge:${target.index}:${target.identityKey}`)
    },
    unregisterPush: async target => {
      calls.push(`unregisterPush:${target.index}:${target.identityKey}`)
    }
  }
}

/** Profiles 0, 1 (active, identity recorded) and 2. */
async function seed(): Promise<void> {
  __resetProfilesForTests()
  await appendProfile('main')
  await appendProfile('test')
  await updateProfile(1, { identityKey: IDENTITY })
  await setActiveProfile(1)
}

const snapshot = () => JSON.stringify(getProfilesState())

beforeEach(async () => {
  calls = []
  checked = []
  script = {
    supported: true,
    ready: true,
    online: true,
    liveIdentityKey: undefined,
    settled: true,
    empty: [{ ok: true }],
    closed: { ok: true },
    lookup: { kind: 'none' },
    release: { kind: 'released', paymail: PAYMAIL },
    switchLands: true,
    switchMovesStore: true
  }
  await seed()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('a profile that holds nothing and has no handle', () => {
  it('runs the steps in order and tombstones only after the switch has landed', async () => {
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'removed', index: 1 })
    expect(calls).toEqual([
      'online',
      'settleHandleJournal',
      'checkEmpty',
      `lookupHandle:${IDENTITY}`,
      'switchToDefault',
      `checkClosed:${IDENTITY}`,
      `tombstone:${IDENTITY}`,
      `purge:1:${IDENTITY}`,
      `unregisterPush:1:${IDENTITY}`
    ])
    expect(checked).toEqual([IDENTITY])
    expect(getActiveProfileIndex()).toBe(0)
    expect(getProfilesState().profiles[1]).toMatchObject({ index: 1, identityKey: IDENTITY, deleted: true })
  })

  it('keeps the removed index: the list stays dense and a new profile takes the next slot', async () => {
    await removeProfileFlow(makeDeps(1))
    expect(getProfilesState().profiles.map(p => p.index)).toEqual([0, 1, 2])
    const added = await appendProfile('main')
    expect(added.index).toBe(3)
  })
})

describe('a profile with a handle', () => {
  beforeEach(() => {
    script.lookup = { kind: 'found', paymail: PAYMAIL }
  })

  it('releases the handle after the checks and before the switch, and proves the profile empty again in between', async () => {
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'removed', index: 1 })
    expect(calls.slice(0, 8)).toEqual([
      'online',
      'settleHandleJournal',
      'checkEmpty',
      `lookupHandle:${IDENTITY}`,
      `releaseHandle:${PAYMAIL}`,
      'checkEmpty',
      'switchToDefault',
      `checkClosed:${IDENTITY}`
    ])
    expect(checked).toEqual([IDENTITY, IDENTITY])
  })

  it('stops before the switch when something was credited while the release was under way', async () => {
    script.empty = [{ ok: true }, { ok: false, reasons: ['spendable-outputs'] }]
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'blocked', reasons: ['spendable-outputs'] })
    expect(calls).toEqual([
      'online',
      'settleHandleJournal',
      'checkEmpty',
      `lookupHandle:${IDENTITY}`,
      `releaseHandle:${PAYMAIL}`,
      'checkEmpty'
    ])
    expect(snapshot()).toBe(before)
  })

  it('stops before the switch when the second proof cannot be taken', async () => {
    const deps = makeDeps(1)
    let n = 0
    deps.checkEmpty = async () => {
      if (++n === 2) throw new Error('db closed')
      return { ok: true }
    }
    const before = snapshot()
    expect(await removeProfileFlow(deps)).toMatchObject({ kind: 'failed', message: 'db closed' })
    expect(calls).not.toContain('switchToDefault')
    expect(snapshot()).toBe(before)
  })

  describe('a registry that does not answer', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it('is given up on after the timeout: the removal aborts as a handle that may still be held, with nothing changed', async () => {
      const deps = makeDeps(1)
      deps.releaseHandle = () => new Promise(() => {})
      const before = snapshot()
      const run = removeProfileFlow(deps)
      await jest.advanceTimersByTimeAsync(HANDLE_RELEASE_TIMEOUT_MS)
      expect(await run).toEqual({ kind: 'handle-failed' })
      expect(calls).not.toContain('switchToDefault')
      expect(snapshot()).toBe(before)
      expect(jest.getTimerCount()).toBe(0)
    })

    it('does not cut off a release that answers in time', async () => {
      const deps = makeDeps(1)
      deps.releaseHandle = () =>
        new Promise(resolve => setTimeout(() => resolve({ kind: 'released', paymail: PAYMAIL }), 5_000))
      const run = removeProfileFlow(deps)
      await jest.advanceTimersByTimeAsync(5_000)
      expect(await run).toEqual({ kind: 'removed', index: 1 })
    })
  })

  it.each<[string, RegistrationResult]>([
    ['pending (no answer from the registry)', { kind: 'pending' }],
    ['rejected', { kind: 'rejected', code: 'ERR_X', description: 'no' }],
    ['failed', { kind: 'failed', message: 'boom' }],
    ['unavailable', { kind: 'unavailable' }],
    // An unfinished journal of another kind was finished instead: the handle is NOT released.
    ['registered (an outstanding claim was finished instead)', { kind: 'registered', paymail: PAYMAIL }],
    ['changed', { kind: 'changed', paymail: PAYMAIL }],
    ['updated', { kind: 'updated', paymail: PAYMAIL }],
    ['rolled_back', { kind: 'rolled_back', paymail: PAYMAIL }]
  ])('aborts before anything changes when the release comes back %s', async (_name, release) => {
    script.release = release
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'handle-failed' })
    expect(calls).not.toContain('switchToDefault')
    expect(calls.some(c => c.startsWith('tombstone') || c.startsWith('purge') || c.startsWith('unregister'))).toBe(
      false
    )
    expect(snapshot()).toBe(before)
  })

  it('aborts when the release throws', async () => {
    const deps = makeDeps(1)
    deps.releaseHandle = async () => {
      throw new Error('network down')
    }
    const before = snapshot()
    expect(await removeProfileFlow(deps)).toMatchObject({ kind: 'failed', message: 'network down' })
    expect(snapshot()).toBe(before)
  })
})

describe('aborts that leave the store untouched', () => {
  it('a registry lookup that failed: the handle may exist, so nothing is released or removed', async () => {
    script.lookup = { kind: 'failed' }
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'handle-failed' })
    expect(calls).toEqual(['online', 'settleHandleJournal', 'checkEmpty', `lookupHandle:${IDENTITY}`])
    expect(snapshot()).toBe(before)
  })

  it('a handle journal that could not be finished', async () => {
    script.settled = false
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'handle-failed' })
    expect(calls).toEqual(['online', 'settleHandleJournal'])
    expect(snapshot()).toBe(before)
  })

  it('a profile that is not empty: every reason is reported and nothing is looked up', async () => {
    script.empty = [{ ok: false, reasons: ['spendable-outputs', 'pending-transactions'] }]
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({
      kind: 'blocked',
      reasons: ['spendable-outputs', 'pending-transactions']
    })
    expect(calls).toEqual(['online', 'settleHandleJournal', 'checkEmpty'])
    expect(snapshot()).toBe(before)
  })

  it('an emptiness check that could not run is a refusal, never a pass', async () => {
    script.empty = [{ ok: false, reasons: ['check-failed'] }]
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'blocked', reasons: ['check-failed'] })
    expect(calls).not.toContain('switchToDefault')
  })

  it('an emptiness check that throws is a failure, never a pass', async () => {
    const deps = makeDeps(1)
    deps.checkEmpty = async () => {
      throw new Error('db closed')
    }
    const before = snapshot()
    expect(await removeProfileFlow(deps)).toMatchObject({ kind: 'failed', message: 'db closed' })
    expect(snapshot()).toBe(before)
  })

  it('offline: nothing is asked of the network', async () => {
    script.online = false
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'refused', reason: 'offline' })
    expect(calls).toEqual(['online'])
  })

  it('a wallet that is not open yet', async () => {
    script.ready = false
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'refused', reason: 'not-ready' })
    expect(calls).toEqual([])
  })

  it('an identity that is neither recorded nor readable, since the purge could not find the databases', async () => {
    await updateProfile(1, { identityKey: undefined })
    script.liveIdentityKey = undefined
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'refused', reason: 'not-ready' })
    expect(calls).toEqual(['liveIdentityKey'])
  })

  it('reads the identity from the live wallet when the record has none, and keeps it on the tombstone', async () => {
    await updateProfile(1, { identityKey: undefined })
    script.liveIdentityKey = IDENTITY
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'removed', index: 1 })
    expect(getProfilesState().profiles[1]).toMatchObject({ deleted: true, identityKey: IDENTITY })
    expect(calls).toContain(`purge:1:${IDENTITY}`)
  })
})

describe('a switch that does not land', () => {
  it('leaves no tombstone and purges nothing', async () => {
    script.switchLands = false
    script.switchMovesStore = false
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'switch-failed' })
    expect(calls).toEqual([
      'online',
      'settleHandleJournal',
      'checkEmpty',
      `lookupHandle:${IDENTITY}`,
      'switchToDefault'
    ])
    expect(snapshot()).toBe(before)
    expect(getActiveProfileIndex()).toBe(1)
  })

  it('a switch that claims to have landed but left the store on this profile is not trusted', async () => {
    // switchProfileImpl answers true when the build generation was overtaken (a logout, say),
    // which says nothing about where the store points.
    script.switchLands = true
    script.switchMovesStore = false
    const before = snapshot()
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'switch-failed' })
    expect(calls.some(c => c.startsWith('tombstone') || c.startsWith('purge') || c.startsWith('unregister'))).toBe(
      false
    )
    expect(snapshot()).toBe(before)
  })

  it('a switch that throws', async () => {
    const deps = makeDeps(1)
    deps.switchToDefault = async () => {
      throw new Error('build blew up')
    }
    const before = snapshot()
    expect(await removeProfileFlow(deps)).toEqual({ kind: 'switch-failed' })
    expect(snapshot()).toBe(before)
  })
})

describe('the databases once the profile is closed', () => {
  it('are checked after the switch has landed and before anything is tombstoned or purged', async () => {
    await removeProfileFlow(makeDeps(1))
    const at = (name: string) => calls.findIndex(c => c.startsWith(name))
    expect(at('switchToDefault')).toBeLessThan(at('checkClosed'))
    expect(at('checkClosed')).toBeLessThan(at('tombstone'))
  })

  it('stop the removal when something was credited while the profile was shutting down: nothing is removed', async () => {
    script.closed = { ok: false, reasons: ['spendable-outputs'] }
    const result = await removeProfileFlow(makeDeps(1))
    expect(result).toEqual({ kind: 'blocked', reasons: ['spendable-outputs'] })
    expect(calls.some(c => c.startsWith('tombstone') || c.startsWith('purge') || c.startsWith('unregister'))).toBe(
      false
    )
    // The profile is still there, and the switch to profile 0 stands.
    expect(getProfilesState().profiles[1].deleted).toBeUndefined()
    expect(getActiveProfileIndex()).toBe(0)
  })

  it('stop it too when they cannot be read, which is not the same as empty', async () => {
    script.closed = { ok: false, reasons: ['check-failed'] }
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'blocked', reasons: ['check-failed'] })
    expect(getProfilesState().profiles[1].deleted).toBeUndefined()
  })

  it('stop it when the check throws', async () => {
    const deps = makeDeps(1)
    deps.checkClosed = async () => {
      throw new Error('cannot open')
    }
    expect(await removeProfileFlow(deps)).toMatchObject({ kind: 'failed', message: 'cannot open' })
    expect(getProfilesState().profiles[1].deleted).toBeUndefined()
    expect(calls.some(c => c.startsWith('purge'))).toBe(false)
  })

  it('are not looked at when the switch did not land: the profile is still open', async () => {
    script.switchLands = false
    script.switchMovesStore = false
    await removeProfileFlow(makeDeps(1))
    expect(calls.some(c => c.startsWith('checkClosed'))).toBe(false)
  })
})

describe('what may never be removed', () => {
  it('profile 0, whatever else is true', async () => {
    await setActiveProfile(0)
    expect(await removeProfileFlow(makeDeps(0))).toEqual({ kind: 'refused', reason: 'profile-zero' })
    expect(await checkProfileRemoval(makeDeps(0))).toEqual({ kind: 'refused', reason: 'profile-zero' })
    expect(calls).toEqual([])
    expect(getProfilesState().profiles[0].deleted).toBeUndefined()
  })

  it('a profile that is not the open one', async () => {
    // Profile 1 is active; profile 2 is not.
    expect(await removeProfileFlow(makeDeps(2))).toEqual({ kind: 'refused', reason: 'not-active' })
    expect(calls).toEqual([])
    expect(getProfilesState().profiles[2].deleted).toBeUndefined()
  })

  it('a profile that was removed already', async () => {
    await setActiveProfile(0)
    await updateProfile(1, { deleted: true })
    await setActiveProfile(2)
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'refused', reason: 'not-active' })
  })

  it('a record that does not exist', async () => {
    expect(await removeProfileFlow(makeDeps(9))).toEqual({ kind: 'refused', reason: 'not-active' })
  })

  it('a wallet without profiles (a recovered key)', async () => {
    script.supported = false
    expect(await removeProfileFlow(makeDeps(1))).toEqual({ kind: 'refused', reason: 'unsupported' })
    expect(calls).toEqual([])
  })
})

describe('what happens after the tombstone', () => {
  it('a purge or push hook that throws does not undo the removal', async () => {
    const deps = makeDeps(1)
    deps.purge = async () => {
      throw new Error('disk full')
    }
    deps.unregisterPush = async () => {
      throw new Error('server too old')
    }
    expect(await removeProfileFlow(deps)).toEqual({ kind: 'removed', index: 1 })
    expect(getProfilesState().profiles[1].deleted).toBe(true)
  })

  it('the push hook still runs after a failed purge', async () => {
    const deps = makeDeps(1)
    const order: string[] = []
    deps.purge = async () => {
      order.push('purge')
      throw new Error('disk full')
    }
    deps.unregisterPush = async () => {
      order.push('unregisterPush')
    }
    await removeProfileFlow(deps)
    expect(order).toEqual(['purge', 'unregisterPush'])
  })

  it('a tombstone the store refuses is reported, with nothing purged', async () => {
    const deps = makeDeps(1)
    deps.tombstone = async () => {
      throw new Error('The active profile cannot be removed')
    }
    expect(await removeProfileFlow(deps)).toMatchObject({ kind: 'failed' })
    expect(calls.some(c => c.startsWith('purge') || c.startsWith('unregister'))).toBe(false)
  })
})

describe('checkProfileRemoval (the dry run behind the Remove row)', () => {
  it('answers ok with no handle and changes nothing', async () => {
    const before = snapshot()
    expect(await checkProfileRemoval(makeDeps(1))).toEqual({ kind: 'ok', handle: null })
    expect(calls).toEqual(['online', 'settleHandleJournal', 'checkEmpty', `lookupHandle:${IDENTITY}`])
    expect(snapshot()).toBe(before)
  })

  it('names the handle that would be released, without releasing it', async () => {
    script.lookup = { kind: 'found', paymail: PAYMAIL }
    expect(await checkProfileRemoval(makeDeps(1))).toEqual({ kind: 'ok', handle: PAYMAIL })
    expect(calls.some(c => c.startsWith('releaseHandle'))).toBe(false)
    expect(calls).not.toContain('switchToDefault')
  })

  it('reports blockers, an unreadable registry and offline the same way the removal would', async () => {
    script.empty = [{ ok: false, reasons: ['inbox-pending'] }]
    expect(await checkProfileRemoval(makeDeps(1))).toEqual({ kind: 'blocked', reasons: ['inbox-pending'] })
    script.empty = [{ ok: true }]
    script.lookup = { kind: 'failed' }
    expect(await checkProfileRemoval(makeDeps(1))).toEqual({ kind: 'handle-failed' })
    script.online = false
    expect(await checkProfileRemoval(makeDeps(1))).toEqual({ kind: 'refused', reason: 'offline' })
  })
})
