/**
 * `buildColorModule`: the one place the wallet assembles the BRC-207 color
 * module (plan 07 Task 10). Since B7 the module is registered with the
 * Mandala issuer-v1 profile only (no attested profile), over a host ledger in
 * the wallet's key-value table, and its default provider is the Mandala
 * overlay provider for this chain (W3).
 */
import type { DatabaseSync } from 'node:sqlite'
import { PrivateKey } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { MANDALA_PROFILE_ID } from '@bsv/mandala/profile'
import { buildColorModule } from '../../core/mandala/colorModule'
import type { WalletKv } from '../../core/mandala/kvStore'
import { openTestDb } from '../__helpers__/nodeSqlite'

const ADMIN = 'admin.example'
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}

const refuseFetch = (async () => {
  throw new Error('no network in this test')
}) as unknown as typeof fetch

function fakeUnderlyingWallet() {
  return {
    getVersion: jest.fn(async () => ({ version: 'bsv-wallet-1.0.0' })),
    getPublicKey: jest.fn(async () => ({ publicKey: new PrivateKey(7).toPublicKey().toString() }))
  } as never
}

let raw: DatabaseSync
let kv: WalletKv

beforeEach(async () => {
  ;({ raw, kv } = await openTestDb())
})

afterEach(() => raw.close())

describe('buildColorModule', () => {
  it('advertises the color capability and no attested profile', async () => {
    const { module } = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    const manager = new WalletPermissionsManager(fakeUnderlyingWallet(), ADMIN, {
      permissionModules: { color: module }
    } as never)
    const { version } = await manager.getVersion({}, ADMIN)
    expect(version).not.toMatch(/brc207-color-attested/)
    expect(version).toMatch(/brc207-color=4/)
    module.dispose()
  })

  it('registers exactly the Mandala issuer-v1 profile', () => {
    const { module } = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    const profiles = (module as unknown as { profiles: ReadonlyMap<string, unknown> }).profiles
    expect([...profiles.keys()]).toEqual([MANDALA_PROFILE_ID])
  })

  it('keeps the host ledger in the wallet key-value table, where the hold reads it', async () => {
    const b = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    const txid = 'ab'.repeat(32)
    await b.ledger.put({ v: 1, txid, assetId: `${'cd'.repeat(32)}_0`, state: 'pending', outputs: [0], at: 1 })
    expect(await kv.getKeyValue(`mandala.host.v1.record.${txid}`)).toBeDefined()
    expect((await b.ledger.get(txid))?.state).toBe('pending')
    expect(typeof b.module.markSettled).toBe('function')
  })

  it('routes the provider to the configured overlay and key', () => {
    const b = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    expect(b.provider.url).toBe(EP.overlayUrl)
    expect(b.provider.identityKey).toBe(EP.overlayIdentityKey)
  })

  it('gives the module a store over the wallet key-value table', async () => {
    const b = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    await b.store.set('color.v1.probe', 'x')
    expect(await kv.getKeyValue('color.v1.probe')).toBe('x')
  })

  it('fails closed on an overlay identity key that is not a point (no module is built)', () => {
    expect(() =>
      buildColorModule({
        wallet: fakeUnderlyingWallet(),
        endpoints: { ...EP, overlayIdentityKey: '02' + '00'.repeat(32) },
        kv,
        requestTokenAccess: async () => true,
        fetch: refuseFetch
      })
    ).toThrow(TypeError)
  })
})
