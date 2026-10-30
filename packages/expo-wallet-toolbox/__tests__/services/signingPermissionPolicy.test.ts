import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { SigningPolicyPermissionsManager, keyIDTag } from '../../core/services/signingPermissionPolicy'

const ADMIN = 'admin.wallet'

function manager() {
  const calls: { method: string; args: any; originator?: string }[] = []
  const rec = (method: string) => async (args: any, originator?: string) => {
    calls.push({ method, args, originator })
    return method === 'createSignature' ? { signature: [1] } : { valid: true }
  }
  const underlying = {
    createSignature: rec('createSignature'),
    verifySignature: rec('verifySignature')
  }
  const prompts: any[] = []
  const pm = new SigningPolicyPermissionsManager(underlying as any, ADMIN, {
    seekProtocolPermissionsForSigning: true
  } as any)
  pm.bindCallback('onProtocolPermissionRequested', (request: any) => {
    prompts.push(request)
  })
  // Stand-in for the on-chain mint (the fake wallet cannot build a PushDrop):
  // records each permission token the manager would create, with its tags.
  const minted: { request: any; tags: string[] }[] = []
  ;(pm as any).createPermissionOnChain = async (request: any) => {
    minted.push({ request, tags: (pm as any).buildTagsForRequest(request) })
  }
  return { pm, calls, prompts, minted }
}

const SERVER = '02' + 'ab'.repeat(32)

test.each(['auth message signature', ' Auth Message Signature '])(
  'signs under %p (BRC-103/104) without a prompt',
  async name => {
    const { pm, calls, prompts } = manager()
    await expect(
      pm.createSignature(
        { protocolID: [2, name], keyID: 'nonce nonce', counterparty: SERVER, data: [1] },
        'app.example'
      )
    ).resolves.toEqual({ signature: [1] })
    await pm.verifySignature(
      { protocolID: [2, name], keyID: 'nonce nonce', counterparty: SERVER, data: [1], signature: [1] },
      'app.example'
    )
    expect(prompts).toEqual([])
    expect(calls.map(c => c.method)).toEqual(['createSignature', 'verifySignature'])
  }
)

// The full check (token lookup, then the prompt) is the parent's; the
// subclass only decides whether to skip it.
test.each([
  ['another protocol', { protocolID: [2, 'some app protocol'], keyID: 'x', counterparty: 'anyone' }],
  [
    'a privileged auth signature',
    { protocolID: [2, 'auth message signature'], keyID: 'x', counterparty: SERVER, privileged: true }
  ]
] as const)('still runs the full permission check for %s', async (_label, args) => {
  const full = jest
    .spyOn(WalletPermissionsManager.prototype, 'ensureProtocolPermission')
    .mockRejectedValue(new Error('denied'))
  try {
    const { pm, calls } = manager()
    await expect(pm.createSignature({ ...args, data: [1] } as any, 'app.example')).rejects.toThrow('denied')
    expect(full).toHaveBeenCalledWith(expect.objectContaining({ usageType: 'signing', protocolID: args.protocolID }))
    expect(calls).toEqual([])
  } finally {
    full.mockRestore()
  }
})

test.each([undefined, '', 'https://app.example'])('still refuses originator %p', async originator => {
  const { pm, calls } = manager()
  await expect(
    pm.createSignature(
      { protocolID: [2, 'auth message signature'], keyID: 'x', counterparty: SERVER, data: [1] },
      originator as any
    )
  ).rejects.toThrow(/Originator/)
  expect(calls).toEqual([])
})

describe('BRC-29 asks every time', () => {
  const BRC29 = { protocolID: [2, '3241645161d8'] as [2, string], keyID: 'eGFuYQ== MQ==', counterparty: 'anyone' }

  /** A manager whose prompt answers itself with `answer`, recording each
   * request. The underlying wallet has no listOutputs/createAction, so any
   * attempt to look up or mint a permission token throws. */
  function answering(answer: 'grant' | 'deny') {
    const { pm, calls, prompts, minted } = manager()
    pm.bindCallback('onProtocolPermissionRequested', (request: any) => {
      // Answer after the current tick, like a user tapping the sheet.
      setTimeout(() => {
        if (answer === 'grant') void pm.grantPermission({ requestID: request.requestID })
        else void pm.denyPermission(request.requestID)
      }, 0)
    })
    return { pm, calls, prompts, minted }
  }

  /** Lets the grant's mint, which runs after the signature resolves, finish. */
  const settle = async () => await new Promise(resolve => setTimeout(resolve, 10))

  test('prompts for each signature, even after an approval', async () => {
    const { pm, calls, prompts } = answering('grant')
    await pm.createSignature({ ...BRC29, data: [1] }, 'app.example')
    await settle()
    await pm.createSignature({ ...BRC29, data: [2] }, 'app.example')
    expect(prompts).toHaveLength(2)
    expect(prompts[0].protocolID).toEqual([2, '3241645161d8'])
    expect(calls.map(c => c.args.data)).toEqual([[1], [2]])
  })

  test('puts the key ID on the prompt', async () => {
    const { pm, prompts } = answering('grant')
    await pm.createSignature({ ...BRC29, data: [1] }, 'app.example')
    expect(prompts[0].keyID).toBe(BRC29.keyID)
  })

  test('verifySignature is answered without a prompt', async () => {
    const { pm, calls, prompts } = answering('grant')
    await expect(pm.verifySignature({ ...BRC29, data: [1], signature: [1] } as any, 'app.example')).resolves.toEqual({
      valid: true
    })
    await pm.verifySignature(
      { protocolID: [2, 'some app protocol'], keyID: 'x', counterparty: SERVER, data: [1], signature: [1] } as any,
      'app.example'
    )
    expect(prompts).toEqual([])
    expect(calls.map(c => c.method)).toEqual(['verifySignature', 'verifySignature'])
    await expect(pm.verifySignature({ ...BRC29, data: [1], signature: [1] } as any, '')).rejects.toThrow(/Originator/)
  })

  test('records each approval as a token tagged with its key ID', async () => {
    const { pm, minted } = answering('grant')
    await pm.createSignature({ ...BRC29, data: [1] }, 'app.example')
    await settle()
    await pm.createSignature({ ...BRC29, keyID: 'MjAyNi0xMC0wNQ== bGVnYWN5', data: [2] }, 'app.example')
    await settle()
    expect(minted).toHaveLength(2)
    expect(minted[0].tags).toEqual(
      expect.arrayContaining(['originator app.example', 'protocolName 3241645161d8', 'counterparty anyone'])
    )
    expect(minted[0].tags).toContain(keyIDTag(BRC29.keyID))
    expect(minted[1].tags).toContain(keyIDTag('MjAyNi0xMC0wNQ== bGVnYWN5'))
    // Recorded, never reused: no cache entry or recent-grant cover either.
    expect((pm as any).permissionCache.size).toBe(0)
    expect((pm as any).recentGrants.size).toBe(0)
  })

  test('a key ID tag survives lowercasing and fits a tag', () => {
    expect(keyIDTag('aB')).toBe('keyid 6142')
    const long = keyIDTag('x'.repeat(400))
    expect(long).toMatch(/^keyidhash [0-9a-f]{64}$/)
  })

  test('concurrent signatures each get their own prompt', async () => {
    const { pm, calls, prompts } = answering('grant')
    await Promise.all([
      pm.createSignature({ ...BRC29, data: [1] }, 'app.example'),
      pm.createSignature({ ...BRC29, data: [2] }, 'app.example'),
      pm.createSignature({ ...BRC29, data: [3] }, 'app.example')
    ])
    expect(prompts).toHaveLength(3)
    expect(calls).toHaveLength(3)
  })

  test('a denial refuses that signature only', async () => {
    const { pm, calls } = answering('deny')
    await expect(pm.createSignature({ ...BRC29, data: [1] }, 'app.example')).rejects.toThrow(/denied/i)
    expect(calls).toEqual([])
  })

  test('never looks up a stored BRC-29 approval', async () => {
    const { pm } = manager()
    const listOutputs = jest.fn(async () => ({ totalOutputs: 0, outputs: [] }))
    ;(pm as any).underlying.listOutputs = listOutputs
    await expect((pm as any).findProtocolToken('app.example', false, BRC29.protocolID, 'anyone', true)).resolves.toBe(
      undefined
    )
    expect(listOutputs).not.toHaveBeenCalled()
    await (pm as any).findProtocolToken('app.example', false, [2, 'some app protocol'], 'anyone', true)
    expect(listOutputs).toHaveBeenCalled()
  })

  test('a manifest that lists BRC-29 raises no grouped sheet, only the signature prompt', async () => {
    const { pm, calls, prompts } = answering('grant')
    ;(pm as any).config.seekGroupedPermission = true
    const grouped: any[] = []
    const pacts: any[] = []
    pm.bindCallback('onGroupedPermissionRequested', (r: any) => {
      grouped.push(r)
    })
    pm.bindCallback('onCounterpartyPermissionRequested', (r: any) => {
      pacts.push(r)
    })
    const ONE_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    ;(pm as any).manifestCache.set('app.example', {
      groupPermissions: {
        protocolPermissions: [
          { protocolID: [2, '3241645161d8'], counterparty: ONE_G, description: 'sign name tokens' },
          { protocolID: [2, '3241645161d8'], description: 'pay to host a picture' }
        ]
      },
      counterpartyPermissions: { description: 'x', protocols: [{ protocolName: '3241645161d8', description: 'x' }] },
      fetchedAt: Date.now()
    })
    await pm.createSignature({ ...BRC29, counterparty: ONE_G, data: [1] }, 'app.example')
    expect(grouped).toEqual([])
    expect(pacts).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})

describe('retirement', () => {
  const SITE = 'fast.brc.dev'
  const GROUP = {
    protocolPermissions: [{ protocolID: [1, 'fast grouped alpha'], description: 'Test protocol' }]
  }
  const denied = { code: 'ERR_PERMISSION_DENIED' }

  /** A manager with every prompt kind this test raises turned on. Each handler
   * records its requests and never answers. */
  function retiring() {
    const underlying = {
      createSignature: async () => ({ signature: [1] }),
      waitForAuthentication: async () => ({ authenticated: true }),
      listOutputs: async () => ({ totalOutputs: 0, outputs: [] })
    }
    const pm = new SigningPolicyPermissionsManager(underlying as any, ADMIN, {
      seekProtocolPermissionsForSigning: true,
      seekSpendingPermissions: true,
      seekGroupedPermission: true
    } as any)
    const raised = { protocol: [] as any[], spending: [] as any[], grouped: [] as any[] }
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => void raised.protocol.push(r))
    pm.bindCallback('onSpendingAuthorizationRequested', (r: any) => void raised.spending.push(r))
    pm.bindCallback('onGroupedPermissionRequested', (r: any) => void raised.grouped.push(r))
    ;(pm as any).findSpendingToken = async () => undefined
    jest.spyOn(pm as any, 'fetchManifestGroupPermissions').mockResolvedValue(GROUP)
    const sign = (id: string) =>
      pm.createSignature({ protocolID: [2, id], keyID: 'k', counterparty: 'self', data: [1] }, 'app.example')
    const spend = () => pm.ensureSpendingAuthorization({ originator: 'app.example', satoshis: 5, lineItems: [] } as any)
    return { pm, raised, sign, spend }
  }
  const tick = async () => await new Promise(resolve => setTimeout(resolve, 10))
  const activeCount = (pm: unknown) => (pm as any).activeRequests.size

  test('a retired manager denies protocol, spending and grouped prompts without calling handlers', async () => {
    const { pm, raised, sign, spend } = retiring()
    pm.retire()
    expect(pm.isRetired()).toBe(true)
    await expect(sign('some app protocol')).rejects.toMatchObject(denied)
    await expect(spend()).rejects.toMatchObject(denied)
    await expect(pm.waitForAuthentication({}, SITE)).rejects.toMatchObject(denied)
    expect(raised).toEqual({ protocol: [], spending: [], grouped: [] })
    expect(activeCount(pm)).toBe(0)
  })

  test('retire also runs onRetire hooks, once, in the same step', () => {
    const { pm } = retiring()
    const hook = jest.fn()
    pm.onRetire(hook)
    expect(hook).not.toHaveBeenCalled()
    pm.retire()
    pm.retire()
    expect(hook).toHaveBeenCalledTimes(1)
    const late = jest.fn()
    pm.onRetire(late)
    expect(late).toHaveBeenCalledTimes(1)
  })

  test('denyAllActiveRequests ends the calls waiting on a prompt', async () => {
    const { pm, raised, sign, spend } = retiring()
    const signing = sign('some app protocol')
    const spending = spend()
    const grouping = pm.waitForAuthentication({}, SITE)
    await tick()
    expect(raised.protocol).toHaveLength(1)
    expect(raised.spending).toHaveLength(1)
    expect(raised.grouped).toHaveLength(1)
    expect(pm.hasActiveRequest(raised.protocol[0].requestID)).toBe(true)
    pm.retire()
    pm.denyAllActiveRequests()
    for (const call of [signing, spending, grouping]) await expect(call).rejects.toMatchObject(denied)
    expect(activeCount(pm)).toBe(0)
    expect(pm.hasActiveRequest(raised.protocol[0].requestID)).toBe(false)
  })

  test('grouped lock is released after retire', async () => {
    const { pm, raised } = retiring()
    const holder = pm.waitForAuthentication({}, SITE)
    await tick()
    const queued = pm.waitForAuthentication({}, SITE) // parked on the per-originator lock
    await tick()
    expect(raised.grouped).toHaveLength(1)
    pm.retire()
    pm.denyAllActiveRequests()
    await expect(holder).rejects.toMatchObject(denied)
    await expect(queued).rejects.toMatchObject(denied)
    expect(raised.grouped).toHaveLength(1)
    expect(activeCount(pm)).toBe(0)
    expect((pm as any).groupedPermissionFlowTail.size).toBe(0)
  })

  test('a call parked on its manifest fetch raises nothing once the manager is retired', async () => {
    const { pm, raised } = retiring()
    let release!: (v: unknown) => void
    ;(pm as any).fetchManifestGroupPermissions.mockImplementation(() => new Promise(resolve => (release = resolve)))
    const waiting = pm.waitForAuthentication({}, SITE)
    await tick()
    pm.retire()
    pm.denyAllActiveRequests()
    release(GROUP)
    await expect(waiting).rejects.toMatchObject(denied)
    expect(raised.grouped).toEqual([])
    expect(activeCount(pm)).toBe(0)
  })

  test('deny never throws for a missing id', () => {
    const { pm } = retiring()
    expect(() => pm.denyAllActiveRequests()).not.toThrow()
    expect(pm.hasActiveRequest('nope')).toBe(false)
  })
})

describe('connect-time group (peek and mint)', () => {
  const SITE = 'localhost' // read with globalThis.fetch, so a test can serve its manifest
  const ONE_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const MANIFEST = {
    metanet: {
      groupPermissions: {
        description: 'Notes',
        spendingAuthorization: { amount: 5000, description: 'spend up to 5000' },
        protocolPermissions: [
          { protocolID: [2, 'notes'], counterparty: ONE_G, description: 'notes' },
          { protocolID: [1, 'open thing'], description: 'open' },
          { protocolID: [2, '3241645161d8'], description: 'pay' }
        ],
        basketAccess: [{ basket: 'notes', description: 'your notes' }],
        certificateAccess: [{ type: 'AAAA', fields: ['name'], verifierPublicKey: ONE_G, description: 'who you are' }]
      }
    }
  }
  const realFetch = globalThis.fetch
  let fetchMock: jest.Mock
  const serve = (body: unknown, ok = true) => {
    fetchMock = jest.fn(async () => ({ ok, headers: { get: () => null }, body: null, json: async () => body }))
    globalThis.fetch = fetchMock as any
  }
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** A real manager whose token lookups read `held` and whose mint records what it was asked for. */
  function minting() {
    const { pm } = manager()
    ;(pm as any).config.seekGroupedPermission = true
    ;(pm as any).underlying.waitForAuthentication = async () => ({ authenticated: true })
    const held = new Set<string>()
    const key = (k: string, v: unknown) => `${k}:${JSON.stringify(v)}`
    jest
      .spyOn(pm as any, 'hasProtocolPermission')
      .mockImplementation(async (a: any) => held.has(key('p', a.protocolID)))
    jest.spyOn(pm as any, 'hasBasketAccess').mockImplementation(async (a: any) => held.has(key('b', a.basket)))
    jest.spyOn(pm as any, 'hasCertificateAccess').mockImplementation(async (a: any) => held.has(key('c', a.certType)))
    jest
      .spyOn(pm as any, 'findSpendingToken')
      .mockImplementation(async () => (held.has('s') ? { token: 1 } : undefined))
    jest.spyOn(pm as any, 'findProtocolToken').mockResolvedValue(undefined)
    const persisted: { toCreate: any[]; toRenew: any[] }[] = []
    jest.spyOn(pm as any, 'persistPermissionGrant').mockImplementation(async (...args: any[]) => {
      const [toCreate, toRenew] = args as [any[], any[]]
      persisted.push({ toCreate, toRenew })
      for (const { request } of [...toCreate, ...toRenew]) {
        if (request.type === 'spending') held.add('s')
        if (request.type === 'protocol') held.add(key('p', request.protocolID))
        if (request.type === 'basket') held.add(key('b', request.basket))
        if (request.type === 'certificate') held.add(key('c', request.certificate.certType))
      }
    })
    const grouped: any[] = []
    pm.bindCallback('onGroupedPermissionRequested', (r: any) => {
      grouped.push(r)
      void pm.dismissGroupedPermission(r.requestID)
    })
    return { pm, held, persisted, grouped, key }
  }

  test('peek uses the same cached fetch the later check reads', async () => {
    serve(MANIFEST)
    const { pm, grouped } = minting()
    expect(await pm.peekGroupPermissions(SITE)).not.toBeNull()
    await pm.waitForAuthentication({}, SITE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(grouped).toHaveLength(1) // the check still sees the manifest (served from the cache)
  })

  test('peek leaves ask-every-time protocols out', async () => {
    serve(MANIFEST)
    const { pm } = minting()
    const group = await pm.peekGroupPermissions(SITE)
    expect(group!.protocolPermissions!.map(p => p.protocolID[1])).toEqual(['notes', 'open thing'])
    expect(group!.spendingAuthorization).toEqual({ amount: 5000, description: 'spend up to 5000' })
  })

  test('peek failure, timeout and empty manifest give null', async () => {
    const { pm } = minting()
    serve(null, false)
    expect(await pm.peekGroupPermissions(SITE)).toBeNull()
    for (const m of [{}, { metanet: {} }, { metanet: { groupPermissions: { protocolPermissions: [] } } }]) {
      ;(pm as any).manifestCache.clear()
      serve(m)
      expect(await pm.peekGroupPermissions(SITE)).toBeNull()
    }
    ;(pm as any).manifestCache.clear()
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as any
    expect(await pm.peekGroupPermissions(SITE)).toBeNull()
    expect(await pm.peekGroupPermissions('')).toBeNull() // a refused originator is a null, not a throw
  })

  test('peek drops malformed entries a site wrote', async () => {
    serve({
      metanet: {
        groupPermissions: {
          protocolPermissions: [
            { protocolID: 'notes' },
            { protocolID: [9, 'x'] },
            { protocolID: [2, 'ok'], description: 'k' }
          ],
          basketAccess: [{ basket: 5 }, { basket: 'b' }],
          spendingAuthorization: { amount: -1 }
        }
      }
    })
    const { pm } = minting()
    expect(await pm.peekGroupPermissions(SITE)).toEqual({
      protocolPermissions: [{ protocolID: [2, 'ok'], description: 'k' }],
      basketAccess: [{ basket: 'b', description: '' }],
      certificateAccess: []
    })
  })

  test('mint creates a token for every listed item and skips items already holding one', async () => {
    serve(MANIFEST)
    const { pm, held, persisted, key } = minting()
    const group = (await pm.peekGroupPermissions(SITE))!
    held.add(key('b', 'notes'))
    await pm.mintGroupedPermissions(SITE, group)
    expect(persisted).toHaveLength(1)
    const types = persisted[0].toCreate.map(c => c.request.type)
    expect(types.sort()).toEqual(['certificate', 'protocol', 'protocol', 'spending'])
    expect(persisted[0].toRenew).toEqual([])
    // A second mint finds everything held and writes nothing.
    await pm.mintGroupedPermissions(SITE, group)
    expect(persisted).toHaveLength(1)
  })

  test('mint renews an expired protocol token instead of creating a second', async () => {
    serve(MANIFEST)
    const { pm, persisted } = minting()
    ;(pm as any).findProtocolToken.mockImplementation(async (_o: string, _p: boolean, protocolID: any) =>
      protocolID[1] === 'notes' ? { txid: 'old' } : undefined
    )
    await pm.mintGroupedPermissions(SITE, (await pm.peekGroupPermissions(SITE))!)
    expect(persisted[0].toRenew.map(r => r.request.protocolID[1])).toEqual(['notes'])
    expect(persisted[0].toCreate.some(c => c.request.protocolID?.[1] === 'notes')).toBe(false)
  })

  test('after mint the group check raises no sheet', async () => {
    serve(MANIFEST)
    const { pm, grouped } = minting()
    await pm.mintGroupedPermissions(SITE, (await pm.peekGroupPermissions(SITE))!)
    await pm.waitForAuthentication({}, SITE)
    expect(grouped).toEqual([])
  })

  test('verified: spending authorization is minted with its amount', async () => {
    serve(MANIFEST)
    const { pm, persisted } = minting()
    await pm.mintGroupedPermissions(SITE, (await pm.peekGroupPermissions(SITE))!)
    const spending = persisted[0].toCreate.find(c => c.request.type === 'spending')
    expect(spending).toMatchObject({ amount: 5000, expiry: 0, request: { spending: { satoshis: 5000 } } })
  })

  test('mint never writes an ask-every-time protocol even if handed one', async () => {
    const { pm, persisted } = minting()
    await pm.mintGroupedPermissions(SITE, {
      protocolPermissions: [{ protocolID: [2, '3241645161d8'], description: 'pay' }]
    })
    expect(persisted).toEqual([])
  })

  test('mint failure rejects and the later group check falls back to the group sheet', async () => {
    serve(MANIFEST)
    const { pm, grouped } = minting()
    ;(pm as any).persistPermissionGrant.mockRejectedValueOnce(new Error('no funds for the token'))
    await expect(pm.mintGroupedPermissions(SITE, (await pm.peekGroupPermissions(SITE))!)).rejects.toThrow(
      'no funds for the token'
    )
    await pm.waitForAuthentication({}, SITE)
    expect(grouped).toHaveLength(1)
  })
})
