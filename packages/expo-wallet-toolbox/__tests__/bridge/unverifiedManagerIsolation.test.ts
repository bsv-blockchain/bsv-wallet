/**
 * Spec 8, against the real manager: namespace isolation for baskets and certificates, grants that
 * last, and spending that never rides a manifest.
 */
import * as sdk from '@bsv/sdk'
import { buildUnverifiedPermissionsManager } from '../../core/bridge/unverifiedManager'
import {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  effectiveUnverified
} from '../../core/bridge/permissionPolicy'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return { ...actual, createPublicHTTPSFetch: jest.fn() }
})

const ADMIN = 'admin.wallet'
const U1 = 'example.com.gaaaaaaaaaa.unverified.invalid'
const U2 = 'example.com.gbbbbbbbbbb.unverified.invalid'
const flags = {
  ...effectiveUnverified({ verified: DEFAULT_VERIFIED_SEEK_FLAGS, unverified: DEFAULT_UNVERIFIED_SEEK_FLAGS }),
  seekCertificateDisclosurePermissions: true
}
const TOKEN = { tx: [], txid: 'aa', outputIndex: 0, expiry: 0 }

function fakeWallet() {
  const calls: string[] = []
  const rec = (m: string, r: unknown) => async () => (calls.push(m), r)
  return {
    calls,
    wallet: {
      listOutputs: rec('listOutputs', { totalOutputs: 0, outputs: [] }),
      createAction: rec('createAction', { txid: 'aa' }),
      waitForAuthentication: rec('waitForAuthentication', { authenticated: true })
    } as never
  }
}

const manager = () => buildUnverifiedPermissionsManager(fakeWallet().wallet, ADMIN, flags)
const internals = (pm: unknown) => pm as Record<string, any>

describe('namespace isolation, for baskets and certificates', () => {
  async function ensureBasket(pm: any, originator: string) {
    return pm.ensureBasketAccess({ originator, basket: 'stuff', reason: 'r', usageType: 'listing' })
  }
  async function ensureCertificate(pm: any, originator: string) {
    return pm.ensureCertificateAccess({
      originator,
      privileged: false,
      verifier: '02' + 'ab'.repeat(32),
      certType: 'c',
      fields: ['f'],
      reason: 'r',
      usageType: 'disclosure'
    })
  }

  describe.each([
    ['basket', 'findBasketToken', 'onBasketAccessRequested', ensureBasket],
    ['certificate', 'findCertificateToken', 'onCertificateAccessRequested', ensureCertificate]
  ] as const)('%s', (_kind, finder, callback, ensure) => {
    function setup(holders: string[]) {
      const pm = manager()
      const asked: string[] = []
      const prompts: string[] = []
      internals(pm)[finder] = async (originator: string) => {
        asked.push(originator)
        return holders.includes(originator) ? TOKEN : undefined
      }
      internals(pm).isTokenExpired = () => false
      pm.bindCallback(callback, ((r: { requestID: string; originator: string }) => {
        prompts.push(r.originator)
        void pm.denyPermission(r.requestID)
      }) as never)
      return { pm, asked, prompts }
    }

    it('a token for example.com never satisfies the namespace', async () => {
      const { pm, asked, prompts } = setup(['example.com'])
      await expect(ensure(pm, U1)).rejects.toThrow()
      expect(asked).toEqual([U1])
      expect(prompts).toEqual([U1])
    })

    it('a namespace token never satisfies example.com', async () => {
      const { pm, prompts } = setup([U1])
      await expect(ensure(pm, 'example.com')).rejects.toThrow()
      expect(prompts).toEqual(['example.com'])
    })

    it('a token under one grant tag never satisfies another', async () => {
      const { pm, prompts } = setup([U1])
      await expect(ensure(pm, U1)).resolves.toBe(true)
      expect(prompts).toEqual([])
      await expect(ensure(pm, U2)).rejects.toThrow()
      expect(prompts).toEqual([U2])
    })
  })
})

describe('grants last', () => {
  it('a non-ephemeral grant is minted under the namespace originator, and a later binding is not asked again', async () => {
    const pm = manager()
    const minted: Array<{ originator: string; expiry: number }> = []
    const holders = new Set<string>()
    internals(pm).findBasketToken = async (o: string) => (holders.has(o) ? TOKEN : undefined)
    internals(pm).isTokenExpired = () => false
    internals(pm).createPermissionOnChain = async (r: { originator: string }, expiry: number) => {
      minted.push({ originator: r.originator, expiry })
      holders.add(r.originator)
    }
    let prompts = 0
    pm.bindCallback('onBasketAccessRequested', ((r: { requestID: string }) => {
      prompts++
      void pm.grantPermission({ requestID: r.requestID })
    }) as never)

    await pm.listOutputs({ basket: 'stuff' } as never, U1)
    expect(prompts).toBe(1)
    expect(minted).toEqual([{ originator: U1, expiry: 0 }])

    // The first binding has closed; the same remembered site opens another.
    await pm.listOutputs({ basket: 'stuff' } as never, U1)
    expect(prompts).toBe(1)
    // A clean slate (another grant tag) is asked.
    await pm.listOutputs({ basket: 'stuff' } as never, U2)
    expect(prompts).toBe(2)
  })

  it('a grouped grant mints the normal tokens under the namespace, and no spending token from the manifest', async () => {
    ;(sdk as any).createPublicHTTPSFetch.mockReturnValue(
      jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        body: null,
        json: async () => ({
          metanet: {
            groupPermissions: {
              description: 'Example',
              spendingAuthorization: { amount: 50_000, description: 'spend a lot' },
              protocolPermissions: [{ protocolID: [2, 'notes app'], counterparty: 'self', description: 'notes' }],
              basketAccess: [{ basket: 'stuff', description: 'stuff' }]
            }
          }
        })
      })
    )
    const pm = manager()
    const persisted: Array<{ request: { type: string; originator: string }; amount?: number }> = []
    internals(pm).findProtocolToken = async () => undefined
    internals(pm).persistPermissionGrant = async (toCreate: typeof persisted) => void persisted.push(...toCreate)
    let asked: any
    pm.bindCallback('onGroupedPermissionRequested', ((r: any) => {
      asked = r
      void pm.grantGroupedPermission({ requestID: r.requestID, granted: r.permissions })
    }) as never)

    await pm.waitForAuthentication({}, U1)
    expect(asked.permissions.spendingAuthorization).toBeUndefined()
    expect(persisted.map(p => p.request.type).sort()).toEqual(['basket', 'protocol'])
    expect(persisted.every(p => p.request.originator === U1)).toBe(true)
    expect(persisted.some(p => p.amount !== undefined)).toBe(false)
  })
})

describe('spending always asks', () => {
  /** A wallet whose createAction returns a signable transaction that spends `inputSats` and pays `outputSats`. */
  function spendingWallet(inputSats: number, outputSats: number) {
    const source = new sdk.Transaction()
    source.addOutput({ satoshis: inputSats, lockingScript: sdk.LockingScript.fromHex('51') })
    const tx = new sdk.Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new sdk.UnlockingScript([]),
      sequence: 0xffffffff
    })
    tx.addOutput({ satoshis: outputSats, lockingScript: sdk.LockingScript.fromHex('51') })
    const beef = new sdk.Beef()
    beef.mergeTransaction(tx)
    const calls: string[] = []
    const wallet = {
      createAction: async () => {
        calls.push('createAction')
        return { signableTransaction: { reference: 'ref', tx: beef.toBinaryAtomic(tx.id('hex')) } }
      },
      signAction: async () => {
        calls.push('signAction')
        return { txid: tx.id('hex') }
      },
      abortAction: async () => {
        calls.push('abortAction')
        return { aborted: true }
      },
      listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
      listActions: async () => ({ totalActions: 0, actions: [] }),
      encrypt: async (a: { plaintext: number[] }) => ({ ciphertext: a.plaintext }),
      decrypt: async (a: { ciphertext: number[] }) => ({ plaintext: a.ciphertext })
    } as never
    const inputBeef = new sdk.Beef()
    inputBeef.mergeTransaction(source)
    return { wallet, calls, outpoint: `${source.id('hex')}.0`, inputBEEF: inputBeef.toBinary() }
  }

  function managerFor(wallet: never) {
    const pm = buildUnverifiedPermissionsManager(wallet, ADMIN, flags)
    internals(pm).ensureLabelAccess = async () => {}
    internals(pm).ensureBasketAccess = async () => true
    const spending: Array<{ originator: string; requestID: string }> = []
    pm.bindCallback('onSpendingAuthorizationRequested', ((r: { requestID: string; originator: string }) => {
      spending.push(r)
      void pm.denyPermission(r.requestID)
    }) as never)
    return { pm, spending }
  }

  it('a createAction with net spend above zero prompts for the namespace originator, before signing', async () => {
    const { wallet, calls } = spendingWallet(10_000, 5000)
    const { pm, spending } = managerFor(wallet)
    const err: any = await pm
      .createAction(
        {
          description: 'pay somebody',
          outputs: [{ lockingScript: '51', satoshis: 5000, outputDescription: 'to them' }]
        } as never,
        U1
      )
      .catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(spending).toHaveLength(1)
    expect(spending[0].originator).toBe(U1)
    expect(calls).not.toContain('signAction')
  })

  it('pinned: a net-zero createAction spending a caller-named input raises no spending prompt', async () => {
    const { wallet, calls, outpoint, inputBEEF } = spendingWallet(10_000, 9_000)
    const { pm, spending } = managerFor(wallet)
    const result: any = await pm.createAction(
      {
        description: 'consolidate',
        inputBEEF,
        inputs: [{ outpoint, inputDescription: 'from the other namespace', unlockingScriptLength: 1 }],
        outputs: [{ lockingScript: '51', satoshis: 9_000, outputDescription: 'to me' }]
      } as never,
      U1
    )
    expect(spending).toEqual([])
    // The manager accepted the action: a signable transaction came back and nothing was aborted.
    expect(result.signableTransaction.reference).toBe('ref')
    expect(calls).toEqual(['createAction'])
  })
})
