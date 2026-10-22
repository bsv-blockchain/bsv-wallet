/**
 * `buildColorModule`: the one place the wallet assembles the BRC-207 color
 * module (plan 07 Task 10). The module is registered with the built-in
 * attested profile and the Mandala issuer-v1 profile, and its default
 * provider is the same Mandala overlay provider the profile routes to (W3).
 */
import type { DatabaseSync } from 'node:sqlite'
import { PrivateKey } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { ATTESTED_PROFILE_ID } from '@bsv/color-permission-module'
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
  it('registers attested + Mandala issuer-v1 and advertises the attested capability', async () => {
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
    expect(version).toMatch(/brc207-color-attested=1/)
    expect(version).toMatch(/brc207-color=4/)
    module.dispose()
  })

  it('registers exactly the attested and Mandala issuer-v1 profiles', () => {
    const { module } = buildColorModule({
      wallet: fakeUnderlyingWallet(),
      endpoints: EP,
      kv,
      requestTokenAccess: async () => true,
      fetch: refuseFetch
    })
    const profiles = (module as unknown as { profiles: ReadonlyMap<string, unknown> }).profiles
    expect([...profiles.keys()].sort()).toEqual([ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID].sort())
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
