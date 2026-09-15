/**
 * Who gets a Mandala runtime, and who gets `undefined`.
 *
 * `useWallet().mandala === undefined` is the ONLY signal the UI has for "this
 * wallet cannot do stablecoins right now", and it has to be true in three
 * different situations that have nothing to do with each other: the wallet has
 * not been built yet, the host stated no endpoints for this chain, and the
 * chain is not mainnet (ux §2, v1). So all three are pinned here rather than
 * left to the one `if` in the build.
 *
 * The half that matters most is the MALFORMED entry. An overlay URL with no
 * usable identity key is an overlay this wallet could submit to but could never
 * verify an admission from — a runtime that would happily credit a σ_I nothing
 * checked. That reads as "no endpoints", never as "endpoints with a gap".
 */
import { PrivateKey } from '@bsv/sdk'
import {
  configureToolbox,
  getMandalaEndpoints,
  isMandalaAvailable,
  resetToolboxConfig
} from '../../core/toolboxConfig'
import { createMandalaRuntime } from '../../core/mandala/createRuntime'

const OVERLAY_KEY = PrivateKey.fromRandom().toPublicKey().toString()
const MAIN = {
  overlayUrl: 'https://overlay.issuer.example',
  overlayIdentityKey: OVERLAY_KEY,
  messageBoxUrl: 'https://box.example'
}

afterEach(() => resetToolboxConfig())

describe('the per-chain endpoint gate', () => {
  it('is unconfigured until the host says so — and that is not a crash', () => {
    // Deliberately unlike getBackupUrl, which throws: this is read while
    // building a wallet and while rendering, where "unconfigured" must look
    // like "Mandala off".
    expect(getMandalaEndpoints('main')).toBeUndefined()
    expect(isMandalaAvailable('main')).toBe(false)
  })

  it('is available on main once the host states all three endpoints', () => {
    configureToolbox({ backupUrl: null, mandala: { main: MAIN } })
    expect(getMandalaEndpoints('main')).toEqual(MAIN)
    expect(isMandalaAvailable('main')).toBe(true)
  })

  it('is mainnet-only, even when another chain has complete endpoints', () => {
    configureToolbox({ backupUrl: null, mandala: { main: MAIN, test: MAIN } })
    expect(isMandalaAvailable('test')).toBe(false)
    expect(isMandalaAvailable('teratest')).toBe(false)
  })

  it('treats a half-stated chain as unstated', () => {
    configureToolbox({
      backupUrl: null,
      mandala: { main: { ...MAIN, overlayIdentityKey: '' } }
    })
    expect(getMandalaEndpoints('main')).toBeUndefined()
    expect(isMandalaAvailable('main')).toBe(false)
  })

  it('refuses an identity key that is not a compressed pubkey', () => {
    configureToolbox({
      backupUrl: null,
      mandala: { main: { ...MAIN, overlayIdentityKey: 'not-a-key' } }
    })
    expect(getMandalaEndpoints('main')).toBeUndefined()
  })

  it('normalises trailing slashes, because /submit is appended to the origin', () => {
    configureToolbox({
      backupUrl: null,
      mandala: { main: { ...MAIN, overlayUrl: 'https://overlay.issuer.example/', messageBoxUrl: 'https://box.example//' } }
    })
    expect(getMandalaEndpoints('main')).toEqual(MAIN)
  })

  it('is replaced wholesale by a second configureToolbox, never merged', () => {
    configureToolbox({ backupUrl: null, mandala: { main: MAIN } })
    configureToolbox({ backupUrl: null })
    expect(getMandalaEndpoints('main')).toBeUndefined()
  })
})

describe('the runtime the build would publish agrees with the gate', () => {
  /**
   * The provider publishes `runtime.available ? runtime : undefined`, so the
   * two answers must never disagree — a runtime that believed itself available
   * on a chain the gate rejects would be handed to the UI by a future caller
   * that trusted `available` alone.
   *
   * WalletContextProvider itself is not rendered here: importing it pulls
   * `expo-secure-store` through the vault store, which fails to parse under
   * this jest preset today (the same failure `walletBuildRestore.test.tsx`
   * already has, unrelated to Mandala).
   */
  function runtimeFor(chain: 'main' | 'test' | 'teratest') {
    return createMandalaRuntime({
      wallet: { getPublicKey: async () => ({ publicKey: OVERLAY_KEY }) } as never,
      adminOriginator: 'urn:test:admin',
      storage: { sqliteDb: {} } as never,
      chain,
      endpoints: getMandalaEndpoints(chain)
    })
  }

  it('agrees on every chain', () => {
    configureToolbox({ backupUrl: null, mandala: { main: MAIN, test: MAIN } })
    for (const chain of ['main', 'test', 'teratest'] as const) {
      expect(runtimeFor(chain).available).toBe(isMandalaAvailable(chain))
    }
    expect(isMandalaAvailable('main')).toBe(true)
  })

  it('agrees that an unconfigured build has no runtime', () => {
    expect(runtimeFor('main').available).toBe(false)
    expect(isMandalaAvailable('main')).toBe(false)
  })
})
