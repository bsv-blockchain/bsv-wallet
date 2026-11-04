import { Utils } from '@bsv/sdk'
import { createBindingRegistry, type BindingRegistry, type CloseEvent } from '../../core/bridge/bindings'
import type { KeyValue } from '../../core/bridge/consent'
import type { DispatchRequest, Outcome } from '../../core/bridge/dispatcher'
import {
  createInboxProcessor,
  decodeInboxResult,
  encodeInboxResult,
  inboxDigest,
  parseInboxRecord,
  resolveInboxResult,
  type InboxStore
} from '../../core/bridge/inbox'
import { createMemoryInboxStore, type MemoryInboxStore } from '../../core/bridge/memoryInboxStore'
import { connectionError } from '../../core/bridge/protocol/connectionError'
import type { InboxRecord } from '../../core/bridge/protocol/envelopes'
import { runInboxStoreContract } from './inboxContract'

const bytes = (s: string) => Uint8Array.from(Utils.toArray(s, 'utf8'))
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MIN = 60_000

runInboxStoreContract('memory adapter', clock => {
  const store = createMemoryInboxStore({ now: clock.now })
  return { store, restart: () => store.restart(), rawBytes: () => store.rawBytes() }
})

function memoryKv(): KeyValue {
  const data = new Map<string, string>()
  return {
    getItem: async k => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async k => void data.delete(k),
    getAllKeys: async () => [...data.keys()]
  }
}

let t: number
let store: MemoryInboxStore
let bindings: BindingRegistry
let dispatched: DispatchRequest[]
let dispatchImpl: (req: DispatchRequest) => Promise<Outcome>
let closeListeners: Set<(e: CloseEvent) => void>
let snapListeners: Set<() => void>
let registeredAttestation: 'browser' | 'unattested'
let snap: { walletRevision: string; accountContext: string; readiness?: 'ready' | 'building' | 'blocked' | 'none' }

const OK: Outcome = { ok: true, result: { height: 1 } }

function record(n: number, over: Partial<InboxRecord> = {}): InboxRecord {
  return {
    v: 1,
    id: ID(n),
    kind: 'invoke',
    epoch: `epoch-${n}`,
    instanceId: 'inst',
    continuityKey: 'ck',
    origin: 'https://example.com',
    accountContext: 'ctx',
    walletRevision: '1',
    boundAt: t - MIN,
    method: 'getHeight',
    args: {},
    createdAt: t,
    notAfter: t + 5 * MIN,
    ...over
  }
}

async function stage(r: InboxRecord, s: InboxStore = store) {
  expect(await s.create(r.id, bytes(JSON.stringify(r)))).toBe(true)
}

function processor(over: { store?: InboxStore } = {}) {
  return createInboxProcessor({
    store: over.store ?? store,
    dispatch: async ({ request }) => {
      dispatched.push(request)
      return dispatchImpl(request)
    },
    now: () => t,
    bindings,
    transport: { id: 'q1', attestation: 'browser' },
    snapshot: () => snap,
    registeredTransport: () => ({ attestation: registeredAttestation }),
    onClosed: fn => {
      closeListeners.add(fn)
      return () => closeListeners.delete(fn)
    },
    onSnapshotChange: fn => {
      snapListeners.add(fn)
      return () => snapListeners.delete(fn)
    }
  })
}

async function result(n: number) {
  return resolveInboxResult(store, ID(n))
}

beforeEach(async () => {
  t = 10_000_000
  store = createMemoryInboxStore({ now: () => t })
  closeListeners = new Set()
  snapListeners = new Set()
  bindings = createBindingRegistry({
    tombstoneStorage: memoryKv(),
    now: () => t,
    onClosed: e => [...closeListeners].forEach(f => f(e))
  })
  await bindings.load()
  dispatched = []
  registeredAttestation = 'browser'
  snap = { walletRevision: '1', accountContext: 'ctx' }
  dispatchImpl = async req => {
    await req.beforeCall?.()
    return OK
  }
})

describe('inbox processor', () => {
  it('shares one retained expiry result across overlapping sweeps', async () => {
    jest.useFakeTimers()
    const write = store.writeResult.bind(store)
    let full = true
    const attempts = jest.spyOn(store, 'writeResult').mockImplementation(async (id, value) => {
      if (full) throw { code: 'ERR_RESOURCE_LIMIT' }
      return write(id, value)
    })
    await stage(record(1, { notAfter: t - 1 }))
    const inbox = processor()
    try {
      const first = inbox.sweepExpired()
      await jest.advanceTimersByTimeAsync(0)
      const second = inbox.sweepExpired()
      await jest.advanceTimersByTimeAsync(0)
      expect(attempts).toHaveBeenCalledTimes(1)
      full = false
      await jest.advanceTimersByTimeAsync(1000)
      await Promise.all([first, second])
      expect(attempts).toHaveBeenCalledTimes(2)
      expect(await result(1)).toMatchObject({ ok: false, error: { delivery: 'not-sent' } })
      expect(dispatched).toHaveLength(0)
    } finally {
      inbox.dispose()
      jest.useRealTimers()
    }
  })

  it('does not dispatch readiness waits after disposal or restart a disposed processor', async () => {
    snap = { walletRevision: '1', accountContext: 'ctx', readiness: 'building' }
    await stage(record(1))
    const inbox = processor()
    const done = inbox.processPending()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await store.stat(ID(1))).toMatchObject({ state: 'accepted' })
    inbox.dispose()
    snap = { walletRevision: '1', accountContext: 'ctx', readiness: 'ready' }
    snapListeners.forEach(notify => notify())
    await done
    await inbox.processPending()
    expect(dispatched).toHaveLength(0)
    expect(await store.stat(ID(1))).toMatchObject({ state: 'accepted' })
  })

  it('leaves listed requests pending when disposal occurs during the native listing', async () => {
    await stage(record(1))
    const inbox = processor()
    const list = store.list.bind(store)
    jest.spyOn(store, 'list').mockImplementation(async state => {
      const ids = await list(state)
      if (state === 'pending') inbox.dispose()
      return ids
    })
    await inbox.processPending()
    expect(dispatched).toHaveLength(0)
    expect(await store.stat(ID(1))).toMatchObject({ state: 'pending' })
  })

  it('stops retrying primitive native errors without replaying the wallet call', async () => {
    const attempts = jest.spyOn(store, 'writeResult').mockRejectedValue('native store unavailable')
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const inbox = processor()
    try {
      await stage(record(1))
      await inbox.processPending()
      await inbox.processPending()
      expect(attempts).toHaveBeenCalledTimes(1)
      expect(dispatched).toHaveLength(1)
      expect(await store.stat(ID(1))).toMatchObject({ state: 'claimed' })
    } finally {
      inbox.dispose()
      warning.mockRestore()
    }
  })

  it('reports a lost native claim as not-sent without executing the wallet', async () => {
    await stage(record(1))
    jest.spyOn(store, 'claim').mockResolvedValue('not-accepted')
    let calls = 0
    dispatchImpl = async request => {
      await request.beforeCall?.()
      calls++
      return OK
    }
    const inbox = processor()
    await inbox.processPending()
    expect(calls).toBe(0)
    expect(await result(1)).toMatchObject({ ok: false, error: { delivery: 'not-sent' } })
    inbox.dispose()
  })

  it('preserves unknown delivery after a claimed wallet call throws', async () => {
    await stage(record(1))
    dispatchImpl = async request => {
      await request.beforeCall?.()
      throw new Error('wallet outcome unavailable')
    }
    const inbox = processor()
    await inbox.processPending()
    await inbox.processPending()
    expect(dispatched).toHaveLength(1)
    expect(await result(1)).toMatchObject({ ok: false, error: { delivery: 'unknown' } })
    inbox.dispose()
  })

  it('keeps only one wallet outcome waiting for native result capacity', async () => {
    jest.useFakeTimers()
    let full = true
    const write = store.writeResult.bind(store)
    jest.spyOn(store, 'writeResult').mockImplementation(async (id, bytes) => {
      if (full) throw { code: 'ERR_RESOURCE_LIMIT' }
      return write(id, bytes)
    })
    let calls = 0
    dispatchImpl = async req => {
      await req.beforeCall?.()
      calls++
      return OK
    }
    for (let n = 1; n <= 3; n++) await stage(record(n, { origin: `https://app${n}.example` }))
    const inbox = processor()
    const done = inbox.processPending()
    await jest.advanceTimersByTimeAsync(0)
    expect(dispatched).toHaveLength(3)
    expect(calls).toBe(1)
    full = false
    await jest.advanceTimersByTimeAsync(1000)
    await done
    expect(calls).toBe(3)
    for (let n = 1; n <= 3; n++) expect(await result(n)).toMatchObject({ ok: true })
    inbox.dispose()
    jest.useRealTimers()
  })

  it('retains an exact completed outcome until result quota is reclaimed in the same boot', async () => {
    jest.useFakeTimers()
    const write = store.writeResult.bind(store)
    let full = true
    const attempts = jest.spyOn(store, 'writeResult').mockImplementation(async (id, bytes) => {
      if (full) throw { code: 'ERR_RESOURCE_LIMIT' }
      return write(id, bytes)
    })
    await stage(record(1))
    const inbox = processor()
    const done = inbox.processPending()
    await jest.advanceTimersByTimeAsync(0)
    expect(dispatched).toHaveLength(1)
    expect(await store.stat(ID(1))).toMatchObject({ state: 'claimed' })
    expect(attempts).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(999)
    expect(attempts).toHaveBeenCalledTimes(1)
    full = false
    await jest.advanceTimersByTimeAsync(1)
    await done
    expect(dispatched).toHaveLength(1)
    expect(await result(1)).toMatchObject({ ok: true, result: { height: 1 } })
    inbox.dispose()
    jest.useRealTimers()
  })

  it('cancels quota retries on disposal without redispatching a claimed operation', async () => {
    jest.useFakeTimers()
    const attempts = jest.spyOn(store, 'writeResult').mockRejectedValue({ code: 'ERR_RESOURCE_LIMIT' })
    await stage(record(1))
    await stage(record(2, { origin: 'https://other.example' }))
    let calls = 0
    dispatchImpl = async req => {
      await req.beforeCall?.()
      calls++
      return OK
    }
    const inbox = processor()
    const done = inbox.processPending()
    await jest.advanceTimersByTimeAsync(0)
    inbox.dispose()
    await done
    await jest.advanceTimersByTimeAsync(5000)
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveLength(2)
    expect(calls).toBe(1)
    expect(await store.stat(ID(1))).toMatchObject({ state: 'claimed' })
    expect(await store.stat(ID(2))).toMatchObject({ state: 'accepted' })
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
  })

  it('does not retry unrelated result-write failures', async () => {
    const attempts = jest.spyOn(store, 'writeResult').mockRejectedValue({ code: 'ERR_RESET' })
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await stage(record(1))
    await processor().processPending()
    expect(attempts).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveLength(1)
    warning.mockRestore()
  })

  it('finishes an individually oversized result with explicit unknown delivery', async () => {
    const write = store.writeResult.bind(store)
    jest.spyOn(store, 'writeResult')
      .mockRejectedValueOnce({ code: 'ERR_RESULT_TOO_LARGE' })
      .mockImplementation(write)
    await stage(record(1))
    await processor().processPending()
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', delivery: 'unknown' } })
    expect(dispatched).toHaveLength(1)
  })

  it('runs a record through accept, claim and dispatch, and stores the result', async () => {
    await stage(record(1))
    await processor().processPending()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ epoch: 'epoch-1', method: 'getHeight', accountContext: 'ctx' })
    expect(await result(1)).toEqual({ v: 1, id: ID(1), ok: true, result: { height: 1 } })
    expect(await store.stat(ID(1))).toMatchObject({ state: 'done', claimBootId: store.bootId() })
    // The binding exists for later records on the same epoch.
    expect(bindings.live().map(b => b.epoch)).toEqual(['epoch-1'])
  })

  it('stores wallet errors and connection errors as error results', async () => {
    await stage(record(1))
    await stage(record(2))
    dispatchImpl = async req => {
      await req.beforeCall?.()
      return req.epoch === 'epoch-1'
        ? {
            ok: false,
            walletError: { isError: true, code: 6, name: 'WERR_INVALID_PARAMETER', message: 'x' } as any,
            delivery: 'not-sent'
          }
        : { ok: false, connectionError: connectionError('USER_CANCELLED', 'no', 'not-sent') }
    }
    await processor().processPending()
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 6 } })
    expect(await result(2)).toMatchObject({ ok: false, error: { code: 'USER_CANCELLED' } })
  })

  it('accepts in createdAt order and starts without waiting for earlier records', async () => {
    await stage(record(1, { createdAt: t - 1000, epoch: 'a' }))
    await stage(record(2, { createdAt: t - 3000, epoch: 'b' }))
    await stage(record(3, { createdAt: t - 2000, epoch: 'c' }))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    dispatchImpl = async req => {
      if (req.epoch === 'b') await gate
      await req.beforeCall?.()
      return OK
    }
    const done = processor().processPending()
    await new Promise(r => setTimeout(r, 0))
    expect(dispatched.map(r => r.epoch)).toEqual(['b', 'c', 'a'])
    expect(await store.stat(ID(2))).toMatchObject({ state: 'accepted' })
    expect(await store.stat(ID(1))).toMatchObject({ state: 'done' })
    release()
    await done
  })

  it('bounds materialized records before dispatcher admission while earlier work is parked', async () => {
    for (let n = 1; n <= 20; n++) await stage(record(n, { epoch: `e-${n}`, origin: `https://app${n}.example` }))
    const read = jest.spyOn(store, 'read')
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    dispatchImpl = async req => {
      await gate
      await req.beforeCall?.()
      return OK
    }
    const inbox = processor()
    const done = inbox.processPending()
    expect(inbox.processPending()).toBe(done)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(read).toHaveBeenCalledTimes(16)
    expect(dispatched).toHaveLength(16)
    expect(await store.stat(ID(17))).toMatchObject({ state: 'pending' })
    release()
    await done
    expect(dispatched).toHaveLength(20)
  })

  it('waits for byte capacity before reading the next pending payload', async () => {
    for (let n = 1; n <= 3; n++) await stage(record(n, { origin: `https://app${n}.example` }))
    const originalStat = store.stat.bind(store)
    jest.spyOn(store, 'stat').mockImplementation(async id => {
      const st = await originalStat(id)
      return st ? { ...st, size: 3 * 1024 * 1024 } : undefined
    })
    const read = jest.spyOn(store, 'read')
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    dispatchImpl = async req => {
      await gate
      await req.beforeCall?.()
      return OK
    }
    const done = processor().processPending()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(read).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveLength(1)
    release()
    await done
    expect(dispatched).toHaveLength(3)
  })

  it('admits a later nudge within the shared budget while an earlier request is parked', async () => {
    await stage(record(1))
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    dispatchImpl = async req => {
      if (req.epoch === 'epoch-1') await gate
      await req.beforeCall?.()
      return OK
    }
    const inbox = processor()
    const done = inbox.processPending()
    await new Promise(resolve => setTimeout(resolve, 0))
    await stage(record(2, { origin: 'https://later.example' }))
    expect(inbox.processPending()).toBe(done)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dispatched).toHaveLength(2)
    expect(await result(2)).toMatchObject({ ok: true })
    release()
    await done
  })

  it('releases materialization slots when a record handler throws', async () => {
    await stage(record(1))
    jest.spyOn(bindings, 'admitImplicit').mockImplementationOnce(() => { throw new Error('admission failed') })
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(processor().processPending()).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledWith('[bridge] inbox record failed', expect.any(Error))
    warning.mockRestore()
  })

  it('skips records withdrawn or accepted after a pending-list snapshot', async () => {
    await stage(record(1))
    await stage(record(2))
    const inbox = processor()
    await inbox.recover()
    expect(await store.accept(ID(2))).toBe(true)
    const originalList = store.list.bind(store)
    jest.spyOn(store, 'list').mockImplementation(async state =>
      state === 'pending' ? [ID(99), ID(2), ...(await originalList(state))] : originalList(state)
    )
    const read = jest.spyOn(store, 'read')
    await inbox.processPending()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(ID(1))
    expect(dispatched).toHaveLength(1)
    expect(await store.stat(ID(2))).toMatchObject({ state: 'accepted' })
  })

  it('rescans when a nudge arrives while an empty pending snapshot is suspended', async () => {
    const originalList = store.list.bind(store)
    let release!: () => void
    let captured!: () => void
    const paused = new Promise<void>(resolve => { captured = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let first = true
    jest.spyOn(store, 'list').mockImplementation(async state => {
      const ids = await originalList(state)
      if (state === 'pending' && first) {
        first = false
        captured()
        await gate
      }
      return ids
    })
    const inbox = processor()
    const done = inbox.processPending()
    await paused
    await stage(record(1))
    expect(inbox.processPending()).toBe(done)
    release()
    await done
    expect(dispatched).toHaveLength(1)
    expect(await result(1)).toMatchObject({ ok: true })
  })

  it('checks the size before reading', async () => {
    await store.create(ID(1), new Uint8Array(5 * 1024 * 1024 + 1))
    const read = jest.spyOn(store, 'read')
    await processor().processPending()
    expect(read).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(0)
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', delivery: 'not-sent' } })
  })

  it('refuses a malformed record, and one stored under another id', async () => {
    await store.create(ID(1), bytes('{not json'))
    await store.create(ID(2), bytes(JSON.stringify(record(3))))
    await processor().processPending()
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR' } })
    expect(await result(2)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR' } })
    expect(dispatched).toHaveLength(0)
    expect(parseInboxRecord(bytes(JSON.stringify(record(3))), ID(3))).toBeDefined()
  })

  describe('notAfter', () => {
    it('applies while pending: an expired record is CONNECTION_CLOSED, not-sent, never dispatched', async () => {
      await stage(record(1, { notAfter: t + MIN }))
      t += 2 * MIN
      await processor().processPending()
      expect(dispatched).toHaveLength(0)
      expect(await result(1)).toMatchObject({
        ok: false,
        error: { code: 'CONNECTION_CLOSED', delivery: 'not-sent' }
      })
    })

    it('is clamped to 15 minutes after createdAt', async () => {
      await stage(record(1, { notAfter: t + 60 * MIN }))
      t += 16 * MIN
      await processor().processPending()
      expect(dispatched).toHaveLength(0)
      expect(await result(1)).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED' } })
    })

    it('does not apply once accepted: a parked record outlives it', async () => {
      await stage(record(1, { notAfter: t + MIN }))
      let release!: () => void
      const gate = new Promise<void>(r => (release = r))
      dispatchImpl = async req => {
        await gate
        await req.beforeCall?.()
        return OK
      }
      const p = processor()
      const done = p.processPending()
      await new Promise(r => setTimeout(r, 0))
      t += 10 * MIN
      await p.sweepExpired()
      expect(await store.stat(ID(1))).toMatchObject({ state: 'accepted' })
      release()
      await done
      expect(await result(1)).toMatchObject({ ok: true })
    })

    it('sweepExpired answers expired pending records without dispatching and without readiness', async () => {
      await stage(record(1, { notAfter: t + MIN }))
      await stage(record(2, { notAfter: t + 10 * MIN, epoch: 'e2' }))
      t += 2 * MIN
      await processor().sweepExpired()
      expect(await result(1)).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED' } })
      expect(await result(2)).toBeUndefined()
      expect(await store.stat(ID(2))).toMatchObject({ state: 'pending' })
    })
  })

  it('refuses createdAt more than 5 minutes in the future, allows 5 minutes of skew', async () => {
    await stage(record(1, { createdAt: t + 6 * MIN, notAfter: t + 10 * MIN }))
    await stage(record(2, { createdAt: t + 4 * MIN, notAfter: t + 10 * MIN, epoch: 'e2' }))
    await processor().processPending()
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
    expect(dispatched.map(r => r.epoch)).toEqual(['e2'])
  })

  describe('crash recovery', () => {
    it('a record claimed under another boot id with no result is CONNECTION_CLOSED, unknown, never re-dispatched', async () => {
      await stage(record(1))
      await store.accept(ID(1))
      await store.claim(ID(1), inboxDigest(bytes(JSON.stringify(record(1)))))
      const after = store.restart()
      await createInboxProcessor({
        store: after,
        dispatch: async ({ request }) => {
          dispatched.push(request)
          return OK
        },
        now: () => t,
        bindings,
        transport: { id: 'q1', attestation: 'browser' },
        snapshot: () => snap,
        registeredTransport: () => ({ attestation: 'browser' }),
        onClosed: () => () => {},
        onSnapshotChange: () => () => {}
      }).processPending()
      expect(dispatched).toHaveLength(0)
      expect(await resolveInboxResult(after, ID(1))).toMatchObject({
        ok: false,
        error: { code: 'CONNECTION_CLOSED', delivery: 'unknown' }
      })
    })

    it('a record claimed in this boot is left alone by recovery', async () => {
      await stage(record(1))
      await store.accept(ID(1))
      await store.claim(ID(1), inboxDigest(bytes(JSON.stringify(record(1)))))
      await processor().recover()
      expect(await result(1)).toBeUndefined()
    })

    it('an accepted record returns to pending after a restart and is then dispatched', async () => {
      await stage(record(1))
      await store.accept(ID(1))
      const after = store.restart()
      const p = createInboxProcessor({
        store: after,
        dispatch: async ({ request }) => {
          dispatched.push(request)
          await request.beforeCall?.()
          return OK
        },
        now: () => t,
        bindings,
        transport: { id: 'q1', attestation: 'browser' },
        snapshot: () => snap,
        registeredTransport: () => ({ attestation: 'browser' }),
        onClosed: () => () => {},
        onSnapshotChange: () => () => {}
      })
      await p.recover()
      expect(await after.stat(ID(1))).toMatchObject({ state: 'pending' })
      await p.processPending()
      expect(dispatched).toHaveLength(1)
    })
  })

  it('a result is purged after 15 minutes and a later read is CONNECTION_CLOSED, unknown', async () => {
    await stage(record(1))
    await processor().processPending()
    expect(await result(1)).toMatchObject({ ok: true })
    t += 16 * MIN
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED', delivery: 'unknown' } })
  })

  it('a re-check failure after the claim is PROVIDER_CHANGED, not-sent, and the wallet is not called', async () => {
    await stage(record(1))
    const wallet = jest.fn()
    dispatchImpl = async req => {
      await req.beforeCall?.()
      // The dispatcher's synchronous re-check (6.6 step 8) fails after the claim.
      if (snap.walletRevision !== '1') {
        return {
          ok: false,
          connectionError: connectionError('PROVIDER_CHANGED', 'changed', 'not-sent', { cause: 'account-changed' })
        }
      }
      wallet()
      return OK
    }
    const orig = store.claim.bind(store)
    jest.spyOn(store, 'claim').mockImplementation(async (id, d) => {
      const r = await orig(id, d)
      snap = { ...snap, walletRevision: '2' }
      return r
    })
    await processor().processPending()
    expect(wallet).not.toHaveBeenCalled()
    expect(await store.stat(ID(1))).toMatchObject({ state: 'done', claimBootId: store.bootId() })
    expect(await result(1)).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_CHANGED', delivery: 'not-sent', cause: 'account-changed' }
    })
  })

  it('a claim that fails on a changed digest is PROTOCOL_ERROR, not-sent', async () => {
    await stage(record(1))
    jest.spyOn(store, 'claim').mockResolvedValue('digest-mismatch')
    let reached = false
    dispatchImpl = async req => {
      try {
        await req.beforeCall?.()
      } catch (e) {
        return { ok: false, connectionError: e as any }
      }
      reached = true
      return OK
    }
    await processor().processPending()
    expect(reached).toBe(false)
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
  })

  it('concurrent processPending calls dispatch a record once', async () => {
    await stage(record(1))
    const p = processor()
    await Promise.all([p.processPending(), p.processPending()])
    expect(dispatched).toHaveLength(1)
  })

  it('a stale wallet revision tombstones the epoch with account-changed and answers PROVIDER_CHANGED', async () => {
    await stage(record(1, { walletRevision: '0' }))
    await processor().processPending()
    expect(dispatched).toHaveLength(0)
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'PROVIDER_CHANGED', cause: 'account-changed' } })
  })

  it('a disconnect record closes the binding and answers ok', async () => {
    await stage(record(1))
    await stage(
      record(2, { kind: 'disconnect', epoch: 'epoch-1', method: undefined, args: undefined, createdAt: t + 1 })
    )
    // Same epoch: the second record disconnects the binding the first one created.
    await stage(record(3, { epoch: 'epoch-1', createdAt: t + 2 }))
    await processor().processPending()
    expect(await result(2)).toEqual({ v: 1, id: ID(2), ok: true, result: {} })
    expect(bindings.live()).toEqual([])
    expect(await result(3)).toMatchObject({ ok: false, error: { code: 'PROVIDER_CHANGED' } })
  })

  it('result encoding round-trips', () => {
    const r = { v: 1 as const, id: ID(1), ok: true as const, result: { a: [1, 2] } }
    expect(decodeInboxResult(encodeInboxResult(r))).toEqual(r)
    expect(decodeInboxResult(bytes('nope'))).toBeUndefined()
  })
})

describe('inbox processor: trust comes from the registration', () => {
  it('refuses a processor whose attestation differs from the registered transport, and admits nothing', async () => {
    registeredAttestation = 'unattested'
    await stage(record(1))
    await processor().processPending()
    expect(dispatched).toHaveLength(0)
    expect(bindings.live()).toHaveLength(0)
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
  })

  it('a hostile origin string in a record is refused by the registry before any sheet', async () => {
    const trustedBindings = createBindingRegistry({
      tombstoneStorage: memoryKv(),
      now: () => t,
      onClosed: () => {},
      transportInfo: () => ({ attestation: 'browser', bindingMode: 'implicit' })
    })
    await trustedBindings.load()
    await stage(record(2, { origin: 'http://EVIL.example' }))
    await createInboxProcessor({
      store,
      dispatch: async ({ request }) => {
        dispatched.push(request)
        return OK
      },
      now: () => t,
      bindings: trustedBindings,
      transport: { id: 'q1', attestation: 'browser' },
      snapshot: () => snap,
      registeredTransport: () => ({ attestation: 'browser' }),
      onClosed: () => () => {},
      onSnapshotChange: () => () => {}
    }).processPending()
    expect(dispatched).toHaveLength(0)
    expect(await result(2)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR' } })
  })
})

describe('inbox processor: readiness (6.8)', () => {
  const notify = () => [...snapListeners].forEach(f => f())

  it.each(['building', 'blocked'] as const)(
    'parks a record while the runtime is %s and admits it, untombstoned, once ready',
    async state => {
      snap = { walletRevision: '0', accountContext: '', readiness: state }
      await stage(record(1, { accountContext: 'ctx', walletRevision: '1' }))
      const done = processor().processPending()
      await new Promise(r => setTimeout(r, 10))
      expect(dispatched).toHaveLength(0)
      expect(await store.stat(ID(1))).toMatchObject({ state: 'accepted' })
      expect(await result(1)).toBeUndefined()
      expect(bindings.live()).toHaveLength(0)

      snap = { walletRevision: '1', accountContext: 'ctx', readiness: 'ready' }
      notify()
      await done
      expect(dispatched).toHaveLength(1)
      expect(await result(1)).toMatchObject({ ok: true })
    }
  )

  it('a non-ready snapshot never tombstones an epoch as account-changed', async () => {
    snap = { walletRevision: '0', accountContext: '', readiness: 'building' }
    await stage(record(1))
    const events: CloseEvent[] = []
    closeListeners.add(e => events.push(e))
    const done = processor().processPending()
    await new Promise(r => setTimeout(r, 10))
    expect(events).toEqual([])
    snap = { walletRevision: '1', accountContext: 'ctx', readiness: 'ready' }
    notify()
    await done
    expect(events).toEqual([])
    expect(bindings.live()).toHaveLength(1)
  })

  it('answers CONFIGURATION_ERROR, not-sent when there is no wallet at all', async () => {
    snap = { walletRevision: '0', accountContext: '', readiness: 'none' }
    await stage(record(1))
    await processor().processPending()
    expect(dispatched).toHaveLength(0)
    expect(await result(1)).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_ERROR', delivery: 'not-sent' } })
    expect(bindings.live()).toHaveLength(0)
  })
})

describe('inbox processor: close events outbox (6.7)', () => {
  it('closing epoch A writes one close event with a monotonic closeSeq', async () => {
    const p = processor()
    await stage(record(1))
    await stage(record(2))
    await p.processPending()
    bindings.close('epoch-1', 'revoked')
    bindings.close('epoch-2', 'lost')
    await new Promise(r => setTimeout(r, 5))
    expect((await store.readEventsAfter(0)).events).toEqual([
      { v: 1, closeSeq: 1, instanceId: 'inst', epoch: 'epoch-1', reason: 'revoked' },
      { v: 1, closeSeq: 2, instanceId: 'inst', epoch: 'epoch-2', reason: 'lost' }
    ])
    expect((await store.readEventsAfter(1)).events).toHaveLength(1)
  })

  it('a page disconnect is written too, but marked as not to be announced to the page', async () => {
    const p = processor()
    await stage(record(1))
    await p.processPending()
    await stage(record(2, { kind: 'disconnect', epoch: 'epoch-1', method: undefined, args: undefined }))
    await p.processPending()
    await new Promise(r => setTimeout(r, 5))
    expect((await store.readEventsAfter(0)).events).toEqual([
      { v: 1, closeSeq: 1, instanceId: 'inst', epoch: 'epoch-1', reason: 'lost', notifyPage: false }
    ])
  })

  it("ignores another transport's closes", async () => {
    const p = processor()
    closeListeners.forEach(f =>
      f({
        closeSeq: 9,
        epoch: 'x',
        reason: 'lost',
        notifyPage: true,
        transportId: 'other',
        instanceId: 'i',
        applicationOrigin: 'https://example.com'
      })
    )
    await p.processPending()
    expect((await store.readEventsAfter(0)).events).toEqual([])
  })

  it('the event for a closed epoch is in the outbox before any replacement is admitted', async () => {
    const p = processor()
    await stage(record(1))
    await p.processPending()
    const original = store.writeEvent.bind(store)
    store.writeEvent = async ev => {
      await new Promise(r => setTimeout(r, 20))
      return original(ev)
    }
    bindings.close('epoch-1', 'account-changed')
    let seenAtAdmission: unknown[] | undefined
    dispatchImpl = async req => {
      seenAtAdmission = (await store.readEventsAfter(0)).events
      await req.beforeCall?.()
      return OK
    }
    await stage(record(2))
    await p.processPending()
    expect(seenAtAdmission).toEqual([
      { v: 1, closeSeq: 1, instanceId: 'inst', epoch: 'epoch-1', reason: 'account-changed' }
    ])
  })

  it('flushEvents resolves only after every raised close event is written', async () => {
    const p = processor()
    await stage(record(1))
    await stage(record(2))
    await p.processPending()
    const original = store.writeEvent.bind(store)
    store.writeEvent = async ev => {
      await new Promise(r => setTimeout(r, 20))
      return original(ev)
    }
    bindings.close('epoch-1', 'revoked')
    bindings.close('epoch-2', 'lost')
    expect((await store.readEventsAfter(0)).events).toEqual([])
    await p.flushEvents()
    expect((await store.readEventsAfter(0)).events.map(e => e.closeSeq)).toEqual([1, 2])
  })

  it('flushEvents resolves immediately when none pending', async () => {
    const p = processor()
    await expect(p.flushEvents()).resolves.toBeUndefined()
  })

  it('dispose stops writing events', async () => {
    const p = processor()
    await stage(record(1))
    await p.processPending()
    p.dispose()
    bindings.close('epoch-1', 'revoked')
    await new Promise(r => setTimeout(r, 5))
    expect((await store.readEventsAfter(0)).events).toEqual([])
  })
})
