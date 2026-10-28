import { Hash } from '@bsv/sdk'
import { b64uDecode, b64uEncode } from '../../core/bridge/protocol/base64url'
import { createConsentStore, sweepConsentStorage, type KeyValue } from '../../core/bridge/consent'
import { isUnattestedOriginator } from '../../core/bridge/unverifiedOriginator'

const ADMIN = 'admin.wallet'
const ORIGIN = 'https://example.com'

// A deterministic stand-in for the admin wallet: the tag is a keyed digest of the message.
function fakeAdminWallet(secret = 1) {
  const mac = (data: number[]) => {
    let h = secret
    const out: number[] = []
    for (let i = 0; i < 32; i++) {
      for (const b of data) h = (h * 31 + b + i) >>> 0
      out.push(h & 255)
    }
    return out
  }
  return {
    createHmac: jest.fn(async (args: any) => ({ hmac: mac(args.data) })),
    verifyHmac: jest.fn(async (args: any) => {
      const expected = mac(args.data)
      if (expected.length !== args.hmac.length || expected.some((b, i) => b !== args.hmac[i])) {
        throw new Error('HMAC is not valid')
      }
      return { valid: true as const }
    })
  } as any
}

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

function setup(opts: { profileKey?: string; wallet?: any; storage?: ReturnType<typeof memoryKv> } = {}) {
  const storage = opts.storage ?? memoryKv()
  const wallet = opts.wallet ?? fakeAdminWallet()
  const state = { profileKey: opts.profileKey ?? '', now: 1_000_000, counter: 0 }
  const store = createConsentStore({
    storage,
    adminWallet: wallet,
    adminOriginator: ADMIN,
    profileKey: () => state.profileKey,
    now: () => state.now,
    randomBytes: n => new Uint8Array(n).fill(++state.counter)
  })
  return { store, storage, wallet, state }
}

const req = (over: Record<string, unknown> = {}) => ({
  origin: ORIGIN,
  attestation: 'browser' as const,
  transportId: 't1',
  bindingEpoch: 'e1',
  walletRevision: 1,
  connectedBefore: false,
  ...over
})

async function approve(
  s: ReturnType<typeof setup>,
  over: Record<string, unknown> = {},
  ctx = { walletRevision: 1, profileKey: s.state.profileKey }
) {
  const r = s.store.requestConsent(req(over))
  if ('refused' in r) throw new Error(`refused ${r.refused}`)
  const out = await s.store.answerConsent(r.requestId, true, ctx)
  await expect(r.promise).resolves.toBe('approved')
  return out!
}

describe('consent store', () => {
  it('remembered per profile and attestation', async () => {
    const s = setup()
    await approve(s)
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeDefined()
    expect(await s.store.lookup(ORIGIN, 'unattested')).toBeUndefined()
    expect(await s.store.lookup('https://other.com', 'browser')).toBeUndefined()
    // A different profile has its own record set.
    s.state.profileKey = '__p1'
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeUndefined()
    s.state.profileKey = ''
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeDefined()
  })

  it('verified approval has hostname originator and no grant tag or token', async () => {
    const s = setup()
    const out = await approve(s)
    expect(out.record.originator).toBe('example.com')
    expect(out.record.grantTag).toBeUndefined()
    expect(out.reconnectToken).toBeUndefined()
    expect(out.record.reconnectHash).toBeUndefined()
  })

  it('tag failure counts as not connected', async () => {
    const s = setup()
    await approve(s)
    const key = [...s.storage.data.keys()][0]
    const tampered = JSON.parse(s.storage.data.get(key)!)
    tampered.records[0].approvedAt += 1
    s.storage.data.set(key, JSON.stringify(tampered))
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeUndefined()
    expect(await s.store.listConnectedSites()).toHaveLength(0)
    // A wallet that cannot verify at all also means not connected.
    s.wallet.verifyHmac.mockRejectedValue(new Error('locked'))
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeUndefined()
  })

  it('approve mints grantTag and token; only SHA-256 hash stored', async () => {
    const s = setup()
    const out = await approve(s, { attestation: 'unattested' })
    expect(out.record.grantTag).toMatch(/^g[a-z2-7]{10}$/)
    expect(out.record.originator).toBe(`example.com.${out.record.grantTag}.unverified.invalid`)
    expect(isUnattestedOriginator(out.record.originator)).toBe(true)
    expect(out.reconnectToken).toBeDefined()
    expect(b64uDecode(out.reconnectToken!)).toHaveLength(32)
    const expectedHash = b64uEncode(Uint8Array.from(Hash.sha256(Array.from(b64uDecode(out.reconnectToken!)))))
    expect(out.record.reconnectHash).toBe(expectedHash)
    const raw = [...s.storage.data.values()].join('')
    expect(raw).not.toContain(out.reconnectToken!)
    expect(raw).toContain(expectedHash)
  })

  it('checkReconnect accepts the token', async () => {
    const s = setup()
    const out = await approve(s, { attestation: 'unattested' })
    expect(s.store.checkReconnect(out.record, out.reconnectToken)).toBe(true)
  })

  it('rejects wrong token', async () => {
    const s = setup()
    const out = await approve(s, { attestation: 'unattested' })
    const wrong = b64uEncode(new Uint8Array(32).fill(99))
    expect(s.store.checkReconnect(out.record, wrong)).toBe(false)
    expect(s.store.checkReconnect(out.record, 'not base64url!!')).toBe(false)
    expect(s.store.checkReconnect(out.record, b64uEncode(new Uint8Array(5)))).toBe(false)
  })

  it('rejects missing token', async () => {
    const s = setup()
    const out = await approve(s, { attestation: 'unattested' })
    expect(s.store.checkReconnect(out.record, undefined)).toBe(false)
    expect(s.store.checkReconnect(out.record, '')).toBe(false)
    // A record with no hash (never valid for unattested) also never matches.
    expect(s.store.checkReconnect({ ...out.record, reconnectHash: undefined }, out.reconnectToken)).toBe(false)
  })

  it('verified records need no token', async () => {
    const s = setup()
    const out = await approve(s)
    expect(s.store.checkReconnect(out.record, undefined)).toBe(true)
  })

  it('re-approval mints new grant tag and old token fails', async () => {
    const s = setup()
    const first = await approve(s, { attestation: 'unattested' })
    const second = await approve(s, { attestation: 'unattested', connectedBefore: true })
    expect(second.record.grantTag).not.toBe(first.record.grantTag)
    expect(second.record.originator).not.toBe(first.record.originator)
    expect(second.reconnectToken).not.toBe(first.reconnectToken)
    const current = (await s.store.lookup(ORIGIN, 'unattested'))!
    expect(current.grantTag).toBe(second.record.grantTag)
    expect(s.store.checkReconnect(current, first.reconnectToken)).toBe(false)
    expect(s.store.checkReconnect(current, second.reconnectToken)).toBe(true)
  })

  it('decline keeps old record', async () => {
    const s = setup()
    const first = await approve(s, { attestation: 'unattested' })
    const r = s.store.requestConsent(req({ attestation: 'unattested', connectedBefore: true }))
    if ('refused' in r) throw new Error('refused')
    expect(await s.store.answerConsent(r.requestId, false, { walletRevision: 1, profileKey: '' })).toBeUndefined()
    await expect(r.promise).resolves.toBe('declined')
    const current = (await s.store.lookup(ORIGIN, 'unattested'))!
    expect(current.grantTag).toBe(first.record.grantTag)
    expect(s.store.checkReconnect(current, first.reconnectToken)).toBe(true)
  })

  it('one slot per transport', () => {
    const s = setup()
    const a = s.store.requestConsent(req())
    expect('requestId' in a).toBe(true)
    const b = s.store.requestConsent(req({ origin: 'https://other.com', bindingEpoch: 'e2' }))
    expect(b).toEqual({ refused: 'slot-held' })
    // Another transport has its own slot.
    const c = s.store.requestConsent(req({ origin: 'https://other.com', transportId: 't2', bindingEpoch: 'e3' }))
    expect('requestId' in c).toBe(true)
  })

  it('a second binding for the same origin joins the pending request', async () => {
    const s = setup()
    const a = s.store.requestConsent(req())
    const b = s.store.requestConsent(req({ bindingEpoch: 'e2' }))
    if ('refused' in a || 'refused' in b) throw new Error('refused')
    expect(b.requestId).toBe(a.requestId)
    expect(s.store.listPending()).toHaveLength(1)
  })

  it('a joining transport does not keep a slot after the request is answered', async () => {
    const s = setup()
    const a = s.store.requestConsent(req())
    const b = s.store.requestConsent(req({ transportId: 't2', bindingEpoch: 'e2' }))
    if ('refused' in a || 'refused' in b) throw new Error('refused')
    await s.store.answerConsent(a.requestId, false, { walletRevision: 1, profileKey: '' })
    s.state.now += 30_000
    expect(
      'requestId' in s.store.requestConsent(req({ origin: 'https://other.com', transportId: 't2', bindingEpoch: 'e3' }))
    ).toBe(true)
  })

  it('a joining transport does not keep a slot after dropRequestsFor', () => {
    const s = setup()
    s.store.requestConsent(req())
    s.store.requestConsent(req({ transportId: 't2', bindingEpoch: 'e2' }))
    s.store.dropRequestsFor('e1')
    s.store.dropRequestsFor('e2')
    expect(
      'requestId' in s.store.requestConsent(req({ origin: 'https://other.com', transportId: 't2', bindingEpoch: 'e3' }))
    ).toBe(true)
  })

  it('a profile switch while the tag is computed drops the request', async () => {
    const s = setup()
    let release!: () => void
    const gate = new Promise<void>(res => (release = res))
    const inner = s.wallet.createHmac.getMockImplementation()!
    s.wallet.createHmac.mockImplementation(async (args: any) => {
      await gate
      return inner(args)
    })
    const r = s.store.requestConsent(req())
    if ('refused' in r) throw new Error('refused')
    const answered = s.store.answerConsent(r.requestId, true, { walletRevision: 1, profileKey: '' })
    s.state.profileKey = '__p1'
    release()
    expect(await answered).toBeUndefined()
    expect(s.store.listPending()).toHaveLength(0)
    await expect(r.promise).resolves.toBe('declined')
  })

  it('answering frees the slot', async () => {
    const s = setup()
    await approve(s)
    expect('requestId' in s.store.requestConsent(req({ origin: 'https://other.com' }))).toBe(true)
  })

  it('30 s backoff after decline only for that origin+attestation', async () => {
    const s = setup()
    const r = s.store.requestConsent(req())
    if ('refused' in r) throw new Error('refused')
    await s.store.answerConsent(r.requestId, false, { walletRevision: 1, profileKey: '' })
    expect(s.store.requestConsent(req({ bindingEpoch: 'e2' }))).toEqual({ refused: 'backoff' })
    // Other attestation and other origin are unaffected.
    const u = s.store.requestConsent(req({ attestation: 'unattested', bindingEpoch: 'e3' }))
    expect('requestId' in u).toBe(true)
    await s.store.answerConsent((u as any).requestId, false, { walletRevision: 1, profileKey: '' })
    expect('requestId' in s.store.requestConsent(req({ origin: 'https://other.com', bindingEpoch: 'e4' }))).toBe(true)
    s.state.now += 30_000
    // Origin other.com holds the slot now; answer it, then the window has expired for example.com.
    const pending = s.store.listPending()[0]
    await s.store.answerConsent(pending.requestId, false, { walletRevision: 1, profileKey: '' })
    s.state.now += 30_000
    expect('requestId' in s.store.requestConsent(req({ bindingEpoch: 'e5' }))).toBe(true)
  })

  it('stale answer after revision change writes nothing', async () => {
    const s = setup()
    const r = s.store.requestConsent(req())
    if ('refused' in r) throw new Error('refused')
    expect(await s.store.answerConsent(r.requestId, true, { walletRevision: 2, profileKey: '' })).toBeUndefined()
    expect(await s.store.answerConsent(r.requestId, true, { walletRevision: 1, profileKey: '__p1' })).toBeUndefined()
    expect(s.storage.data.size).toBe(0)
    expect(s.store.listPending()).toHaveLength(1)
  })

  it('revision change while the tag is computed writes nothing', async () => {
    const s = setup()
    let release!: () => void
    const gate = new Promise<void>(res => (release = res))
    const inner = s.wallet.createHmac.getMockImplementation()!
    s.wallet.createHmac.mockImplementation(async (args: any) => {
      await gate
      return inner(args)
    })
    const r = s.store.requestConsent(req())
    if ('refused' in r) throw new Error('refused')
    const answered = s.store.answerConsent(r.requestId, true, { walletRevision: 1, profileKey: '' })
    s.store.withdrawAll()
    release()
    expect(await answered).toBeUndefined()
    expect(s.storage.data.size).toBe(0)
    await expect(r.promise).resolves.toBe('declined')
  })

  it('unknown or repeated request id does nothing', async () => {
    const s = setup()
    expect(await s.store.answerConsent('nope', true, { walletRevision: 1, profileKey: '' })).toBeUndefined()
    const r = s.store.requestConsent(req())
    if ('refused' in r) throw new Error('refused')
    await s.store.answerConsent(r.requestId, true, { walletRevision: 1, profileKey: '' })
    expect(await s.store.answerConsent(r.requestId, true, { walletRevision: 1, profileKey: '' })).toBeUndefined()
  })

  it('dropRequestsFor removes request once no binding remains', async () => {
    const s = setup()
    const a = s.store.requestConsent(req())
    s.store.requestConsent(req({ bindingEpoch: 'e2' }))
    if ('refused' in a) throw new Error('refused')
    s.store.dropRequestsFor('e1')
    expect(s.store.listPending()).toHaveLength(1)
    const changes = jest.fn()
    s.store.onChange(changes)
    s.store.dropRequestsFor('e2')
    expect(s.store.listPending()).toHaveLength(0)
    expect(changes).toHaveBeenCalled()
    await expect(a.promise).resolves.toBe('declined')
    // Closing a binding is not a decline: no backoff, and the slot is free.
    expect('requestId' in s.store.requestConsent(req({ bindingEpoch: 'e3' }))).toBe(true)
  })

  it('listConnectedSites and revokeSite', async () => {
    const s = setup()
    await approve(s)
    await approve(s, { attestation: 'unattested', origin: 'https://x.org' })
    const sites = await s.store.listConnectedSites()
    expect(sites.map(x => `${x.applicationOrigin}|${x.attestation}`).sort()).toEqual([
      'https://example.com|browser',
      'https://x.org|unattested'
    ])
    expect(JSON.stringify(sites)).not.toContain('reconnectHash')
    await s.store.revokeSite('https://x.org', 'unattested')
    expect(await s.store.lookup('https://x.org', 'unattested')).toBeUndefined()
    expect(await s.store.lookup(ORIGIN, 'browser')).toBeDefined()
  })

  it('sweep at logout removes profile keys including profile 0 bare key', async () => {
    const s = setup()
    await approve(s)
    s.state.profileKey = '__p1'
    await approve(s)
    s.storage.data.set('bsv-bridge-sites', '{}')
    s.storage.data.set('unrelated', 'keep')
    s.storage.data.set('bsv-bridge-permission-policy:', 'keep')
    await sweepConsentStorage(s.storage)
    expect([...s.storage.data.keys()].sort()).toEqual(['bsv-bridge-permission-policy:', 'unrelated'])
  })
})
