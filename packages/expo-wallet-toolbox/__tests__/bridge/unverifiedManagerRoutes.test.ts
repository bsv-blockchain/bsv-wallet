/**
 * Spec 8, token-module isolation against the real `SigningPolicyPermissionsManager`: every route the
 * manager sends to a token module (`delegateToPModuleIfNeeded` for nine methods, plus the label and
 * basket scans of `listActions` and `internalizeAction`) is refused for an unverified origin
 * without reaching the wallet, and the attested manager still reaches the real module.
 */
import { buildUnverifiedPermissionsManager } from '../../core/bridge/unverifiedManager'
import {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  effectiveUnverified
} from '../../core/bridge/permissionPolicy'
import { SigningPolicyPermissionsManager } from '../../core/services/signingPermissionPolicy'

const ADMIN = 'admin.wallet'
const UNVERIFIED = 'example.com.gaaaaaaaaaa.unverified.invalid'
const flags = effectiveUnverified({ verified: DEFAULT_VERIFIED_SEEK_FLAGS, unverified: DEFAULT_UNVERIFIED_SEEK_FLAGS })

const METHODS = [
  'listOutputs',
  'relinquishOutput',
  'getPublicKey',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'listActions',
  'internalizeAction'
] as const

const PROTOCOL = { protocolID: [2, 'p btms x'], keyID: '1', counterparty: 'self' }
const CASES: Array<[(typeof METHODS)[number], Record<string, unknown>]> = [
  ['listOutputs', { basket: 'p btms x' }],
  ['relinquishOutput', { basket: 'p btms x', output: `${'aa'.repeat(32)}.0` }],
  ['getPublicKey', { ...PROTOCOL }],
  ['encrypt', { ...PROTOCOL, plaintext: [1] }],
  ['decrypt', { ...PROTOCOL, ciphertext: [1] }],
  ['createHmac', { ...PROTOCOL, data: [1] }],
  ['verifyHmac', { ...PROTOCOL, data: [1], hmac: [1] }],
  ['createSignature', { ...PROTOCOL, data: [1] }],
  ['verifySignature', { ...PROTOCOL, data: [1], signature: [1] }],
  ['listActions', { labels: ['p btms x'] }],
  [
    'internalizeAction',
    {
      tx: [1],
      description: 'internalize it',
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'p btms x' } }]
    }
  ]
]

function fakeWallet() {
  const calls: string[] = []
  const wallet: Record<string, unknown> = {}
  for (const m of METHODS) {
    wallet[m] = async () => {
      calls.push(m)
      return {}
    }
  }
  return { wallet: wallet as never, calls }
}

/** Grants every prompt, so only a token module can stop a call. */
function grantAll(pm: SigningPolicyPermissionsManager) {
  const grant = (r: { requestID: string }) => void pm.grantPermission({ requestID: r.requestID })
  for (const cb of [
    'onProtocolPermissionRequested',
    'onBasketAccessRequested',
    'onSpendingAuthorizationRequested',
    'onCertificateAccessRequested'
  ] as const) {
    pm.bindCallback(cb, grant as never)
  }
  const internals = pm as unknown as Record<string, unknown>
  internals.createPermissionOnChain = async () => {}
  internals.ensureLabelAccess = async () => {}
  internals.findProtocolToken = async () => ({ tx: [], txid: 'aa', outputIndex: 0 })
  internals.findBasketToken = async () => ({ tx: [], txid: 'aa', outputIndex: 0 })
}

describe('token-module routes (spec 8)', () => {
  it('covers every method the manager delegates, plus listActions and internalizeAction', () => {
    expect(CASES.map(c => c[0]).sort()).toEqual([...METHODS].sort())
  })

  it.each(CASES)('%s is refused for an unverified origin, before the wallet', async (method, args) => {
    const { wallet, calls } = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    grantAll(pm)
    const err = await (pm as never as Record<string, (a: unknown, o: string) => Promise<unknown>>)
      [method](args, UNVERIFIED)
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(err).toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
    expect(calls).toEqual([])
  })

  it.each(CASES)('%s still reaches the real module for the attested manager', async (method, args) => {
    const { wallet } = fakeWallet()
    const onRequest = jest.fn(async (r: { args: unknown }) => ({ args: r.args }))
    const module = { onRequest, onResponse: async (res: unknown) => res }
    const pm = new SigningPolicyPermissionsManager(wallet, ADMIN, {
      differentiatePrivilegedOperations: true,
      ...DEFAULT_VERIFIED_SEEK_FLAGS,
      permissionModules: { btms: module, mandala: module }
    } as never)
    grantAll(pm)
    await (pm as never as Record<string, (a: unknown, o: string) => Promise<unknown>>)
      [method](args, 'example.com')
      .catch(() => undefined)
    expect(onRequest).toHaveBeenCalled()
    expect(onRequest.mock.calls[0][0]).toMatchObject({ method })
  })
})
