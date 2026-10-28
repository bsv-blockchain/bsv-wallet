import { createBindingRegistry, type CloseEvent } from '../../core/bridge/bindings'
import type { KeyValue } from '../../core/bridge/consent'
import { isConnectionError } from '../../core/bridge/protocol/connectionError'

const DAY = 24 * 60 * 60 * 1000

function memoryKv(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: async k => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async k => void data.delete(k),
    getAllKeys: async () => [...data.keys()]
  }
}

async function setup(opts: { storage?: KeyValue; start?: number } = {}) {
  let t = opts.start ?? 10 * DAY
  const events: CloseEvent[] = []
  const storage = opts.storage ?? memoryKv()
  const reg = createBindingRegistry({
    tombstoneStorage: storage,
    now: () => t++,
    onClosed: e => events.push(e)
  })
  await reg.load()
  return { reg, events, storage, tick: (ms: number) => void (t += ms), time: () => t }
}

const CUR = { walletRevision: '5', accountContext: 'ctx-a' }
let n = 0
const rec = (over: Record<string, unknown> = {}): any => {
  const i = n++
  return {
    epoch: `epoch-${i}`,
    transportId: 'ext',
    attestation: 'browser',
    instanceId: 'inst',
    continuityKey: 'ck',
    origin: 'https://example.com',
    accountContext: CUR.accountContext,
    walletRevision: CUR.walletRevision,
    boundAt: 10 * DAY - 1000,
    ...over
  }
}
const explicit = (over: Record<string, unknown> = {}): any => {
  const r = rec(over)
  const { origin, ...rest } = r
  return { ...rest, applicationOrigin: origin }
}

describe('implicit admission', () => {
  it('creates a live binding for an unknown, current epoch', async () => {
    const { reg } = await setup()
    const r = rec()
    const b = reg.admitImplicit(r, CUR)
    expect(isConnectionError(b)).toBe(false)
    expect(b).toMatchObject({
      epoch: r.epoch,
      transportId: 'ext',
      applicationOrigin: 'https://example.com',
      attestation: 'browser',
      state: 'live',
      consented: false,
      boundAt: r.boundAt
    })
    expect((b as any).launchProofVerified).toBeUndefined()
    expect(reg.live()).toHaveLength(1)
  })

  it('returns the same binding for a repeat record', async () => {
    const { reg } = await setup()
    const r = rec()
    const a = reg.admitImplicit(r, CUR)
    expect(reg.admitImplicit(r, CUR)).toBe(a)
    expect(reg.live()).toHaveLength(1)
  })

  it('tombstones a revision mismatch with account-changed and never admits it again', async () => {
    const { reg, events } = await setup()
    const r = rec({ walletRevision: '4' })
    const e = reg.admitImplicit(r, CUR)
    expect(isConnectionError(e) && e.code).toBe('PROVIDER_CHANGED')
    expect(isConnectionError(e) && e.cause).toBe('account-changed')
    expect(isConnectionError(e) && e.delivery).toBe('not-sent')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ epoch: r.epoch, reason: 'account-changed' })
    // even a record that now matches cannot revive it
    const again = reg.admitImplicit({ ...r, walletRevision: '5' }, CUR)
    expect(isConnectionError(again)).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('tombstones a context mismatch with account-changed', async () => {
    const { reg } = await setup()
    const e = reg.admitImplicit(rec({ accountContext: 'ctx-b' }), CUR)
    expect(isConnectionError(e) && e.cause).toBe('account-changed')
  })

  it('A to B to A cannot revive an epoch', async () => {
    const { reg } = await setup()
    const r = rec()
    expect(isConnectionError(reg.admitImplicit(r, CUR))).toBe(false)
    reg.closeAll('account-changed')
    const B = { walletRevision: '6', accountContext: 'ctx-b' }
    expect(isConnectionError(reg.admitImplicit(r, B))).toBe(true)
    // back on A with the original revision and context
    const back = reg.admitImplicit(r, CUR)
    expect(isConnectionError(back)).toBe(true)
    expect(reg.live()).toHaveLength(0)
  })

  it('refuses an epoch older than 24 hours with lost and tombstones it', async () => {
    const { reg, events } = await setup()
    const r = rec({ boundAt: 10 * DAY - DAY - 5 })
    const e = reg.admitImplicit(r, CUR)
    expect(isConnectionError(e) && e.code).toBe('CONNECTION_CLOSED')
    expect(isConnectionError(e) && e.cause).toBe('lost')
    expect(isConnectionError(e) && e.delivery).toBe('not-sent')
    expect(events).toEqual([expect.objectContaining({ epoch: r.epoch, reason: 'lost' })])
    expect(reg.live()).toHaveLength(0)
  })

  it('refuses an epoch not later than evictedThrough after 1025 closes', async () => {
    const { reg } = await setup()
    const first = rec({ boundAt: 10 * DAY - 5000 })
    expect(isConnectionError(reg.admitImplicit(first, CUR))).toBe(false)
    reg.close(first.epoch, 'revoked')
    for (let i = 0; i < 1024; i++) {
      const r = rec()
      expect(isConnectionError(reg.admitImplicit(r, CUR))).toBe(false)
      reg.close(r.epoch, 'revoked')
    }
    // the ring dropped the first tombstone, so only the watermark stops it
    const e = reg.admitImplicit(first, CUR)
    expect(isConnectionError(e) && e.code).toBe('CONNECTION_CLOSED')
    expect(isConnectionError(e) && e.cause).toBe('lost')
  })

  it('persists the ring and watermark across a restart', async () => {
    const storage = memoryKv()
    const a = await setup({ storage })
    const r = rec()
    a.reg.admitImplicit(r, CUR)
    a.reg.close(r.epoch, 'revoked')
    await a.reg.flush()
    const b = await setup({ storage })
    const e = b.reg.admitImplicit(r, CUR)
    expect(isConnectionError(e) && e.code).toBe('PROVIDER_CHANGED')
    expect(isConnectionError(e) && e.cause).toBe('revoked')
    expect(b.reg.live()).toHaveLength(0)
  })

  it('keeps closeSeq increasing across a restart', async () => {
    const storage = memoryKv()
    const a = await setup({ storage })
    const r = rec()
    a.reg.admitImplicit(r, CUR)
    a.reg.close(r.epoch, 'lost')
    await a.reg.flush()
    const b = await setup({ storage })
    const r2 = rec()
    b.reg.admitImplicit(r2, CUR)
    b.reg.close(r2.epoch, 'lost')
    expect(b.events[0].closeSeq).toBeGreaterThan(a.events[0].closeSeq)
  })
})

describe('closing', () => {
  it('closing A emits one event with increasing closeSeq; B and C stay live', async () => {
    const { reg, events } = await setup()
    const [a, b, c] = [rec(), rec(), rec()]
    for (const r of [a, b, c]) reg.admitImplicit(r, CUR)
    reg.close(a.epoch, 'revoked')
    reg.close(a.epoch, 'revoked')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ epoch: a.epoch, reason: 'revoked', notifyPage: true })
    expect(reg.live().map(x => x.epoch)).toEqual([b.epoch, c.epoch])
    reg.close(b.epoch, 'lost')
    expect(events[1].closeSeq).toBeGreaterThan(events[0].closeSeq)
    expect(reg.live().map(x => x.epoch)).toEqual([c.epoch])
  })

  it('marks the binding closed and resolve refuses it with the reason', async () => {
    const { reg } = await setup()
    const r = rec()
    const b: any = reg.admitImplicit(r, CUR)
    reg.close(r.epoch, 'revoked')
    expect(b.state).toBe('closed')
    expect(b.closeReason).toBe('revoked')
    const res = reg.resolve('ext', { epoch: r.epoch, instanceId: 'inst', continuityKey: 'ck', origin: r.origin })
    expect(isConnectionError(res) && res.code).toBe('PROVIDER_CHANGED')
    expect(isConnectionError(res) && res.cause).toBe('revoked')
  })

  it('closeAll closes every live binding with one event each', async () => {
    const { reg, events } = await setup()
    for (let i = 0; i < 3; i++) reg.admitImplicit(rec(), CUR)
    reg.closeAll('account-changed')
    expect(reg.live()).toHaveLength(0)
    expect(events.map(e => e.reason)).toEqual(['account-changed', 'account-changed', 'account-changed'])
    expect(new Set(events.map(e => e.closeSeq)).size).toBe(3)
  })

  it('a page disconnect tombstones and emits an event but does not notify the page', async () => {
    const { reg, events } = await setup()
    const r = rec()
    reg.admitImplicit(r, CUR)
    reg.close(r.epoch, 'disconnected')
    expect(events).toEqual([expect.objectContaining({ epoch: r.epoch, reason: 'disconnected', notifyPage: false })])
    const e = reg.admitImplicit(r, CUR)
    expect(isConnectionError(e)).toBe(true)
  })

  it('emits the close event synchronously, before the epoch can be replaced', async () => {
    const { reg, events } = await setup()
    const r = rec()
    reg.admitImplicit(r, CUR)
    reg.closeAll('account-changed')
    expect(events).toHaveLength(1)
    const replacement = reg.admitImplicit(rec({ walletRevision: '6' }), {
      walletRevision: '6',
      accountContext: 'ctx-a'
    })
    expect(isConnectionError(replacement)).toBe(false)
    expect(events).toHaveLength(1)
  })
})

describe('resolve', () => {
  it('returns the live binding for a matching request', async () => {
    const { reg } = await setup()
    const r = rec()
    const b = reg.admitImplicit(r, CUR)
    expect(reg.resolve('ext', { epoch: r.epoch, instanceId: 'inst', continuityKey: 'ck', origin: r.origin })).toBe(b)
  })

  it.each([
    ['unknown epoch', { epoch: 'nope' }],
    ['instanceId', { instanceId: 'other' }],
    ['continuityKey', { continuityKey: 'other' }],
    ['origin', { origin: 'https://evil.example' }]
  ])('refuses a mismatched %s with PROVIDER_CHANGED', async (_n, over) => {
    const { reg } = await setup()
    const r = rec()
    reg.admitImplicit(r, CUR)
    const res = reg.resolve('ext', {
      epoch: r.epoch,
      instanceId: 'inst',
      continuityKey: 'ck',
      origin: r.origin,
      ...over
    })
    expect(isConnectionError(res) && res.code).toBe('PROVIDER_CHANGED')
    expect(isConnectionError(res) && res.delivery).toBe('not-sent')
  })

  it('refuses a binding reached through another transport', async () => {
    const { reg } = await setup()
    const r = rec()
    reg.admitImplicit(r, CUR)
    const res = reg.resolve('other', { epoch: r.epoch, instanceId: 'inst', continuityKey: 'ck', origin: r.origin })
    expect(isConnectionError(res) && res.code).toBe('PROVIDER_CHANGED')
  })

  it('refuses a request asserting a different account context', async () => {
    const { reg } = await setup()
    const r = rec()
    reg.admitImplicit(r, CUR)
    const res = reg.resolve('ext', {
      epoch: r.epoch,
      instanceId: 'inst',
      continuityKey: 'ck',
      origin: r.origin,
      accountContext: 'ctx-z'
    })
    expect(isConnectionError(res) && res.cause).toBe('account-changed')
  })
})

describe('explicit connect', () => {
  it('creates a live binding; unattested carries launchProofVerified', async () => {
    const { reg } = await setup()
    const b = reg.connectExplicit(
      explicit({ attestation: 'unattested', transportId: 'loop', launchProofVerified: true })
    )
    expect(b).toMatchObject({ state: 'live', launchProofVerified: true, attestation: 'unattested' })
  })

  it('does not set launchProofVerified on a browser binding', async () => {
    const { reg } = await setup()
    const b: any = reg.connectExplicit(explicit({ launchProofVerified: true }))
    expect('launchProofVerified' in b).toBe(false)
  })

  it('refuses an unattested connect without a launch proof and takes no slot', async () => {
    const { reg } = await setup()
    for (let i = 0; i < 20; i++) {
      expect(() => reg.connectExplicit(explicit({ attestation: 'unattested', transportId: 'loop' }))).toThrow(
        expect.objectContaining({ domain: 'brc185', code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
      )
    }
    expect(reg.live()).toHaveLength(0)
    expect(() =>
      reg.connectExplicit(explicit({ attestation: 'unattested', transportId: 'loop', launchProofVerified: false }))
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }))
    // a real connect still fits
    reg.connectExplicit(explicit({ attestation: 'unattested', transportId: 'loop', launchProofVerified: true }))
    expect(reg.live()).toHaveLength(1)
  })

  it('refuses a tombstoned or duplicate epoch', async () => {
    const { reg } = await setup()
    const i = explicit()
    reg.connectExplicit(i)
    expect(() => reg.connectExplicit(i)).toThrow(expect.objectContaining({ domain: 'brc185' }))
    reg.close(i.epoch, 'lost')
    expect(() => reg.connectExplicit(i)).toThrow(expect.objectContaining({ code: 'PROVIDER_CHANGED' }))
  })

  it('refuses a ninth live binding for one origin with RESOURCE_LIMIT', async () => {
    const { reg } = await setup()
    for (let i = 0; i < 8; i++) reg.connectExplicit(explicit())
    expect(() => reg.connectExplicit(explicit())).toThrow(
      expect.objectContaining({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    )
    // another origin is fine, and a close frees a slot
    reg.connectExplicit(explicit({ origin: 'https://other.example' }))
    reg.close(reg.live()[0].epoch, 'lost')
    reg.connectExplicit(explicit())
  })

  it('refuses the 65th live binding overall, for explicit and implicit alike', async () => {
    const { reg } = await setup()
    for (let i = 0; i < 64; i++) reg.connectExplicit(explicit({ origin: `https://site${i}.example` }))
    expect(() => reg.connectExplicit(explicit({ origin: 'https://another.example' }))).toThrow(
      expect.objectContaining({ code: 'RESOURCE_LIMIT' })
    )
    const e = reg.admitImplicit(rec({ origin: 'https://another.example' }), CUR)
    expect(isConnectionError(e) && e.code).toBe('RESOURCE_LIMIT')
  })
})

describe('markConsented', () => {
  it('records the originator and flags the binding consented', async () => {
    const { reg } = await setup()
    const r = rec()
    const b = reg.admitImplicit(r, CUR) as any
    reg.markConsented(r.epoch, 'example.com')
    expect(b.consented).toBe(true)
    expect(b.originator).toBe('example.com')
  })
})

describe('reconnect token', () => {
  it('is held beside the binding, handed out once, and dropped on close', async () => {
    const { reg } = await setup()
    const a = explicit({ attestation: 'unattested', launchProofVerified: true, reconnectToken: 'tok-a' })
    const b = reg.connectExplicit(a)
    expect(JSON.stringify(b)).not.toContain('tok-a')
    expect(reg.takeReconnectToken(a.epoch)).toBe('tok-a')
    expect(reg.takeReconnectToken(a.epoch)).toBeUndefined()

    const c = explicit({ attestation: 'unattested', launchProofVerified: true, reconnectToken: 'tok-c' })
    reg.connectExplicit(c)
    reg.close(c.epoch, 'disconnected')
    expect(reg.takeReconnectToken(c.epoch)).toBeUndefined()
  })

  it('is ignored on a verified binding', async () => {
    const { reg } = await setup()
    const a = explicit({ reconnectToken: 'tok' })
    reg.connectExplicit(a)
    expect(reg.takeReconnectToken(a.epoch)).toBeUndefined()
  })
})

describe('trust inputs (spec 6.3, 6.2)', () => {
  async function trusted(allowHttp = false) {
    const events: CloseEvent[] = []
    const reg = createBindingRegistry({
      tombstoneStorage: memoryKv(),
      now: () => 10 * DAY,
      onClosed: e => events.push(e),
      transportInfo: id =>
        id === 'ext'
          ? { attestation: 'browser', bindingMode: 'implicit' }
          : id === 'page'
            ? { attestation: 'browser', bindingMode: 'explicit' }
            : id === 'loop'
              ? { attestation: 'unattested', bindingMode: 'explicit' }
              : undefined,
      allowLocalhostHttp: () => allowHttp
    })
    await reg.load()
    return { reg, events }
  }

  it.each([
    ['an http origin', 'http://example.com'],
    ['a userinfo origin', 'https://user@example.com'],
    ['an uppercase host', 'https://EXAMPLE.com'],
    ['a default port', 'https://example.com:443'],
    ['the admin host', 'https://admin.invalid']
  ])('admitImplicit refuses %s as PROTOCOL_ERROR and takes no slot', async (_n, origin) => {
    const { reg, events } = await trusted()
    const res = reg.admitImplicit(rec({ origin }), CUR)
    expect(isConnectionError(res) && res).toMatchObject({ code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    expect(reg.live()).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it('connectExplicit refuses a non-canonical origin', async () => {
    const { reg } = await trusted()
    expect(() => reg.connectExplicit(explicit({ transportId: 'page', origin: 'http://example.com' }))).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_ERROR' })
    )
    expect(reg.live()).toHaveLength(0)
  })

  it('accepts http://localhost only when the host allows it', async () => {
    const off = await trusted(false)
    expect(() => off.reg.connectExplicit(explicit({ transportId: 'page', origin: 'http://localhost:3000' }))).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_ERROR' })
    )
    const on = await trusted(true)
    expect(on.reg.connectExplicit(explicit({ transportId: 'page', origin: 'http://localhost:3000' }))).toMatchObject({
      originator: 'localhost'
    })
  })

  it('refuses an attestation that differs from the registered transport', async () => {
    const { reg } = await trusted()
    // The queue transport is registered as browser; a record claiming unattested is not believed.
    const res = reg.admitImplicit(rec({ attestation: 'unattested' }), CUR)
    expect(isConnectionError(res) && res).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(() => reg.connectExplicit(explicit({ transportId: 'loop', attestation: 'browser' }))).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_ERROR' })
    )
    expect(reg.live()).toHaveLength(0)
  })

  it('refuses an unknown transport and the wrong binding mode', async () => {
    const { reg } = await trusted()
    expect(isConnectionError(reg.admitImplicit(rec({ transportId: 'nope' }), CUR))).toBe(true)
    // `page` is explicit-only.
    expect(isConnectionError(reg.admitImplicit(rec({ transportId: 'page' }), CUR))).toBe(true)
    expect(() => reg.connectExplicit(explicit({ transportId: 'ext' }))).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_ERROR' })
    )
  })

  it('a valid implicit record still admits, with the hostname as the browser originator', async () => {
    const { reg } = await trusted()
    expect(reg.admitImplicit(rec(), CUR)).toMatchObject({ originator: 'example.com', state: 'live' })
  })
})
