import * as sdk from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import {
  buildUnverifiedPermissionsManager,
  filterUnverifiedManifest,
  isUnreadableManifestHost
} from '../../core/bridge/unverifiedManager'
import {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  effectiveUnverified
} from '../../core/bridge/permissionPolicy'
import {
  hasUnattestedTransport,
  onUnattestedTransportChange,
  setUnattestedTransportPresent
} from '../../core/bridge/runtimeFlags'
import { SigningPolicyPermissionsManager } from '../../core/services/signingPermissionPolicy'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return { ...actual, createPublicHTTPSFetch: jest.fn() }
})

const ADMIN = 'admin.wallet'
const TAG1 = 'gaaaaaaaaaa'
const TAG2 = 'gbbbbbbbbbb'
const U = (host: string, tag = TAG1) => `${host}.${tag}.unverified.invalid`

const flags = effectiveUnverified({ verified: DEFAULT_VERIFIED_SEEK_FLAGS, unverified: DEFAULT_UNVERIFIED_SEEK_FLAGS })

function fakeWallet() {
  const calls: { method: string; args: any; originator?: string }[] = []
  const rec =
    (method: string, result: any = {}) =>
    async (args: any, originator?: string) => {
      calls.push({ method, args, originator })
      return result
    }
  const wallet = {
    createSignature: rec('createSignature', { signature: [1] }),
    listOutputs: rec('listOutputs', { totalOutputs: 0, outputs: [] }),
    listActions: rec('listActions', { totalActions: 0, actions: [] }),
    createAction: rec('createAction', { txid: 'aa' }),
    encrypt: async (a: any) => ({ ciphertext: a.plaintext }),
    decrypt: async (a: any) => ({ plaintext: a.ciphertext }),
    getPublicKey: rec('getPublicKey', { publicKey: '02' + 'ab'.repeat(32) })
  }
  return { wallet: wallet as any, calls }
}

function manifestResponse(manifest: unknown) {
  return { ok: true, headers: { get: () => null }, body: null, json: async () => manifest }
}

const mockFetch = (sdk as any).createPublicHTTPSFetch as jest.Mock
let fetchSpy: jest.Mock

beforeEach(() => {
  fetchSpy = jest.fn()
  mockFetch.mockReset()
  mockFetch.mockReturnValue(fetchSpy)
})

describe('manifest', () => {
  const manifest = {
    metanet: {
      groupPermissions: {
        description: 'Example',
        spendingAuthorization: { amount: 10000, description: 'spend' },
        protocolPermissions: [
          { protocolID: [2, 'notes'], description: 'notes' },
          { protocolID: [2, '3241645161d8'], description: 'pay' },
          { protocolID: [2, 'p mandala token'], description: 'tokens' },
          { protocolID: [2, 'p btms x'], description: 'btms' },
          { protocolID: [2, 'p other thing'], description: 'other' }
        ],
        basketAccess: [
          { basket: 'stuff', description: 's' },
          { basket: 'p btms x', description: 'b' }
        ]
      }
    }
  }

  test('manifest fetched from real hostname', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const result = await (pm as any).fetchManifestPermissions(U('example.com'))
    expect(mockFetch).toHaveBeenCalledWith('https://example.com')
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/manifest.json')
    expect(result.groupPermissions.description).toBe('Example')
  })

  test.each([
    'localhost',
    'intranet',
    'printer.local',
    'a.localhost',
    'x.internal',
    'x.lan',
    'x.home.arpa',
    'x.test',
    'x.example',
    'abc.onion',
    '1.2.3.4',
    'foo.123'
  ])('special host %s gives nulls with no fetch', async host => {
    expect(isUnreadableManifestHost(host)).toBe(true)
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    // 1.2.3.4 and foo.123 are not valid namespace hostnames; the override still answers nulls.
    await expect((pm as any).fetchManifestPermissions(U(host))).resolves.toEqual({
      groupPermissions: null,
      counterpartyPermissions: null
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('an ordinary host is readable', () => {
    for (const h of ['example.com', 'sub.example.org', 'testing.dev']) expect(isUnreadableManifestHost(h)).toBe(false)
  })

  test('filters spending, ask-every-time and token-module entries', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const { groupPermissions } = await (pm as any).fetchManifestPermissions(U('example.com'))
    expect(groupPermissions.spendingAuthorization).toBeUndefined()
    expect(groupPermissions.protocolPermissions.map((p: any) => p.protocolID[1])).toEqual(['notes', 'p other thing'])
    expect(groupPermissions.basketAccess.map((b: any) => b.basket)).toEqual(['stuff'])
  })

  test('filters counterparty entries too', () => {
    const out = filterUnverifiedManifest({
      groupPermissions: null,
      counterpartyPermissions: {
        description: 'd',
        protocols: [
          { protocolName: 'chat', protocolID: [2, 'chat'] },
          { protocolName: 'p mandala token', protocolID: [2, 'p mandala token'] },
          { protocolName: '3241645161d8', protocolID: [2, '3241645161d8'] }
        ]
      }
    })
    expect(out.counterpartyPermissions!.protocols.map((p: any) => p.protocolName)).toEqual(['chat'])
  })

  test('delegate objects not mutated', () => {
    const group = {
      spendingAuthorization: { amount: 1 },
      protocolPermissions: [{ protocolID: [2, 'p btms x'] }],
      basketAccess: [{ basket: 'p btms y' }]
    }
    const cp = { protocols: [{ protocolName: 'p btms x', protocolID: [2, 'p btms x'] }] }
    const snapshot = JSON.stringify({ group, cp })
    const out = filterUnverifiedManifest({ groupPermissions: group, counterpartyPermissions: cp })
    expect(JSON.stringify({ group, cp })).toBe(snapshot)
    expect(out.groupPermissions).not.toBe(group)
    expect(out.counterpartyPermissions).not.toBe(cp)
    expect(out.groupPermissions!.protocolPermissions).not.toBe(group.protocolPermissions)
  })

  test('a plain (non-namespace) originator gets nulls', async () => {
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    await expect((pm as any).fetchManifestPermissions('example.com')).resolves.toEqual({
      groupPermissions: null,
      counterpartyPermissions: null
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('the attested manager is untouched', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const { wallet } = fakeWallet()
    buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const attested = new SigningPolicyPermissionsManager(wallet, ADMIN, { ...DEFAULT_VERIFIED_SEEK_FLAGS } as any)
    await (attested as any).fetchManifestPermissions('example.com')
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/manifest.json')
  })
})

describe('prompts', () => {
  function withPrompts(f: typeof flags, wallet = fakeWallet().wallet) {
    const pm = new SigningPolicyPermissionsManager(wallet, ADMIN, {
      differentiatePrivilegedOperations: true,
      ...f
    } as any)
    return pm
  }

  test('basket listing prompts on unverified, not on attested', async () => {
    const { wallet: w1 } = fakeWallet()
    const unverified = buildUnverifiedPermissionsManager(w1, ADMIN, flags)
    const basketPrompts: any[] = []
    unverified.bindCallback('onBasketAccessRequested', (r: any) => {
      basketPrompts.push(r)
      void unverified.denyPermission(r.requestID)
    })
    await expect(unverified.listOutputs({ basket: 'stuff' } as any, U('example.com'))).rejects.toThrow()
    expect(basketPrompts).toHaveLength(1)

    const { wallet: w2 } = fakeWallet()
    const attested = withPrompts(DEFAULT_VERIFIED_SEEK_FLAGS, w2)
    const attestedPrompts: any[] = []
    attested.bindCallback('onBasketAccessRequested', (r: any) => void attestedPrompts.push(r))
    await attested.listOutputs({ basket: 'stuff' } as any, 'example.com')
    expect(attestedPrompts).toEqual([])
  })

  test('namespace tokens never satisfy example.com and vice versa', async () => {
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const found: string[] = []
    ;(pm as any).findProtocolToken = async (originator: string) => {
      found.push(originator)
      // A token exists for example.com only.
      return originator === 'example.com' ? { tx: [], txid: 'aa', outputIndex: 0 } : undefined
    }
    const prompts: any[] = []
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => {
      prompts.push(r)
      void pm.denyPermission(r.requestID)
    })
    const args = { protocolID: [2, 'notes'], keyID: '1', counterparty: 'self', data: [1] } as any
    await expect(pm.createSignature(args, U('example.com'))).rejects.toThrow()
    expect(prompts).toHaveLength(1)
    expect(found).toEqual([U('example.com')])
  })

  test('two grant tags isolated', async () => {
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const tokensFor = new Set([U('example.com', TAG1)])
    ;(pm as any).findProtocolToken = async (originator: string) =>
      tokensFor.has(originator) ? { tx: [], txid: 'aa', outputIndex: 0 } : undefined
    const prompts: any[] = []
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => {
      prompts.push(r)
      void pm.denyPermission(r.requestID)
    })
    ;(pm as any).isTokenExpired = () => false
    const args = { protocolID: [2, 'notes'], keyID: '1', counterparty: 'self', data: [1] } as any
    await pm.createSignature(args, U('example.com', TAG1)).catch(() => {})
    const before = prompts.length
    await expect(pm.createSignature(args, U('example.com', TAG2))).rejects.toThrow()
    expect(prompts.length).toBe(before + 1)
    expect(prompts[prompts.length - 1].originator).toBe(U('example.com', TAG2))
  })

  test.each([
    ['label', 'createAction', { description: 'a tokens spend', labels: ['p mandala token-spend'], outputs: [] }],
    [
      'basket',
      'createAction',
      {
        description: 'a tokens spend',
        outputs: [{ lockingScript: '00', satoshis: 1, basket: 'p btms x', outputDescription: 'token output' }]
      }
    ],
    ['basket list', 'listOutputs', { basket: 'p btms x' }],
    ['protocol', 'createSignature', { protocolID: [2, 'p mandala token'], keyID: '1', counterparty: 'self', data: [1] }]
  ] as const)('token-module routes refused with ERR_PERMISSION_DENIED (%s)', async (_n, method, args) => {
    const { wallet, calls } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => void pm.grantPermission({ requestID: r.requestID }))
    pm.bindCallback('onBasketAccessRequested', (r: any) => void pm.grantPermission({ requestID: r.requestID }))
    pm.bindCallback('onSpendingAuthorizationRequested', (r: any) => void pm.grantPermission({ requestID: r.requestID }))
    ;(pm as any).createPermissionOnChain = async () => {}
    ;(pm as any).findProtocolToken = async () => ({ tx: [], txid: 'aa', outputIndex: 0 })
    ;(pm as any).findBasketToken = async () => ({ tx: [], txid: 'aa', outputIndex: 0 })
    const err = await (pm as any)[method](args, U('example.com')).catch((e: any) => e)
    await expect(Promise.reject(err)).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
    expect(calls.filter(c => c.method === method)).toEqual([])
  })

  test('nosend label still works and its spend prompts', async () => {
    const { wallet, calls } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const spending: any[] = []
    pm.bindCallback('onSpendingAuthorizationRequested', (r: any) => {
      spending.push(r)
      void pm.denyPermission(r.requestID)
    })
    ;(pm as any).ensureLabelAccess = async () => {}
    const args = {
      description: 'protected action',
      labels: ['p nosend expiry seconds 600'],
      outputs: [{ lockingScript: '00', satoshis: 1000, outputDescription: 'token output' }],
      options: { noSend: true }
    } as any
    // The built-in module is reached (not refused as an unsupported scheme or by the stubs): the
    // spend prompt is the proof, and the denial below is the user's.
    const err = await pm.createAction(args, U('example.com')).catch(e => e)
    expect(String(err?.message)).not.toMatch(/Unsupported P-/)
    expect(spending).toHaveLength(1)
    expect(calls.filter(c => c.method === 'createAction')).toEqual([])
  })

  test('BRC-29 prompts every signature', async () => {
    const { wallet, calls } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    const prompts: any[] = []
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => {
      prompts.push(r)
      setTimeout(() => void pm.grantPermission({ requestID: r.requestID }), 0)
    })
    ;(pm as any).createPermissionOnChain = async () => {}
    const args = (n: number) =>
      ({
        protocolID: [2, '3241645161d8'],
        keyID: 'k',
        counterparty: 'anyone',
        data: [n]
      }) as any
    await pm.createSignature(args(1), U('example.com'))
    await new Promise(r => setTimeout(r, 10))
    await pm.createSignature(args(2), U('example.com'))
    expect(prompts).toHaveLength(2)
    expect(calls.filter(c => c.method === 'createSignature')).toHaveLength(2)
  })

  test('is a SigningPolicyPermissionsManager built from the flags', () => {
    const { wallet } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    expect(pm).toBeInstanceOf(WalletPermissionsManager)
    expect((pm as any).config.seekBasketListingPermissions).toBe(true)
    expect((pm as any).config.seekSpendingPermissions).toBe(true)
    expect(Object.keys((pm as any).config.permissionModules).sort()).toEqual(['btms', 'mandala', 'nosend'])
  })
})

describe('runtimeFlags', () => {
  afterEach(() => setUnattestedTransportPresent(false))

  test('tracks presence and notifies only on change', () => {
    const seen: boolean[] = []
    const off = onUnattestedTransportChange(v => seen.push(v))
    expect(hasUnattestedTransport()).toBe(false)
    setUnattestedTransportPresent(true)
    setUnattestedTransportPresent(true)
    expect(hasUnattestedTransport()).toBe(true)
    off()
    setUnattestedTransportPresent(false)
    expect(seen).toEqual([true])
  })
})

describe('connect-time group on the unverified manager', () => {
  const manifest = {
    metanet: {
      groupPermissions: {
        spendingAuthorization: { amount: 10000, description: 'spend' },
        protocolPermissions: [
          { protocolID: [2, 'notes'], description: 'notes' },
          { protocolID: [2, '3241645161d8'], description: 'pay' },
          { protocolID: [2, 'p mandala token'], description: 'tokens' }
        ],
        basketAccess: [{ basket: 'stuff', description: 's' }]
      }
    }
  }

  test('unattested: spending, ask-every-time and token modules are already stripped from the preview', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const pm = buildUnverifiedPermissionsManager(fakeWallet().wallet, ADMIN, flags)
    const group = await pm.peekGroupPermissions(U('example.com'))
    expect(group).toEqual({
      protocolPermissions: [{ protocolID: [2, 'notes'], description: 'notes' }],
      basketAccess: [{ basket: 'stuff', description: 's' }],
      certificateAccess: []
    })
  })

  test('preview under a placeholder grant tag and the later check share one fetch', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const pm = buildUnverifiedPermissionsManager(fakeWallet().wallet, ADMIN, flags)
    await pm.peekGroupPermissions(U('example.com', TAG1))
    await (pm as any).fetchManifestPermissions(U('example.com', TAG2))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('mint is keyed to the approved originator, the one the later check uses', async () => {
    fetchSpy.mockResolvedValue(manifestResponse(manifest))
    const pm = buildUnverifiedPermissionsManager(fakeWallet().wallet, ADMIN, flags)
    const persist = jest.spyOn(pm as any, 'persistPermissionGrant').mockResolvedValue(undefined)
    jest.spyOn(pm as any, 'filterAlreadyGrantedPermissions').mockImplementation(async (_o: any, g: any) => g)
    jest.spyOn(pm as any, 'findProtocolToken').mockResolvedValue(undefined)
    const group = (await pm.peekGroupPermissions(U('example.com')))!
    await pm.mintGroupedPermissions(U('example.com', TAG2), group)
    const created = persist.mock.calls[0][0] as any[]
    expect(created.map(c => c.request.originator)).toEqual([U('example.com', TAG2), U('example.com', TAG2)])
  })
})
