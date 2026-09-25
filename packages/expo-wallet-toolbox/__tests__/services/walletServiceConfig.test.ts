import {
  createServiceOptions,
  createServices,
  installOfflineChainTracker,
  chaintracksUrlFor
} from '../../core/services/walletServiceConfig'
import { Services } from '@bsv/wallet-toolbox-mobile'
import { configureToolbox, resetToolboxConfig, type ToolboxServiceConfig } from '../../core/toolboxConfig'

// The service config now comes from the host, not from process.env — see
// core/toolboxConfig.ts. An empty `services` block is the "host stated nothing
// per-chain" case, which is what exercises the built-in defaults below.
beforeEach(() => {
  configureToolbox({ backupUrl: null })
})
afterEach(() => {
  resetToolboxConfig()
})

const exchangeRate = () => ({ timestamp: new Date(), base: 'USD' as const, rate: 1 })

// Pins the Critical fix: Services.getChainTracker() does NOT delegate to
// options.chaintracks.isValidRootForHeight — it wraps options.chaintracks in
// ChaintracksChainTracker, whose own isValidRootForHeight calls
// findHeaderForHeight with a 6x/250ms retry loop and throws on persistent
// failure (out/src/services/chaintracker/ChaintracksChainTracker.js:21-56).
// Passing an offline-first client as options.chaintracks alone therefore
// never reaches its store-first lookup. installOfflineChainTracker is the
// actual seam; this test is what would have caught the original bug.
describe('installOfflineChainTracker', () => {
  it('makes services.getChainTracker() resolve to the injected tracker', async () => {
    // Stands in for OfflineFirstChaintracks — the point here is the seam
    // (does getChainTracker() actually return what we hand it), not the
    // wrapper's own store-first logic, which offlineChaintracks.test.ts covers.
    const fakeTracker = {
      isValidRootForHeight: jest.fn().mockResolvedValue(true),
      currentHeight: jest.fn().mockResolvedValue(0)
    }

    const options = createServiceOptions('test', 'callback-token', exchangeRate())
    const services = new Services(options)

    installOfflineChainTracker(services, fakeTracker as any)

    const tracker = await services.getChainTracker()
    expect(tracker).toBe(fakeTracker)
  })

  it('without the override, getChainTracker() wraps chaintracks rather than returning it directly', async () => {
    const options = createServiceOptions('test', 'callback-token', exchangeRate())
    const services = new Services(options)

    const tracker = await services.getChainTracker()

    // Sanity check of the seam this fix closes: the untouched default is some
    // other object (ChaintracksChainTracker) wrapping options.chaintracks, not
    // options.chaintracks itself and not anything with the shape we inject.
    expect(tracker).not.toBe(options.chaintracks)
  })
})

// The seam above is only live if something calls it. Until createServices did it
// itself, the single call in context/WalletContext.tsx was the whole guarantee —
// delete that one line and the Critical comes back with no test failing, because
// the wrapper is still injected at options.chaintracks and still never consulted.
// These pin the two halves together: hand createServices an override and the
// Services it returns must already treat it as the chain tracker.
describe('createServices', () => {
  const fakeTracker = () => ({
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    currentHeight: jest.fn().mockResolvedValue(0)
  })

  it('installs a chaintracks override as the chain tracker, not merely as the client behind it', async () => {
    const override = fakeTracker()
    const { services } = createServices(
      'test',
      'callback-token',
      exchangeRate(),
      undefined,
      undefined,
      override as never
    )

    await expect(services.getChainTracker()).resolves.toBe(override)
  })

  it('still passes the override to the service options, which header sync and misses read', async () => {
    const override = fakeTracker()
    const { serviceOptions } = createServices(
      'test',
      'callback-token',
      exchangeRate(),
      undefined,
      undefined,
      override as never
    )

    expect(serviceOptions.chaintracks).toBe(override)
  })

  it('leaves the toolbox default in place when there is no override', async () => {
    const { services, serviceOptions } = createServices('test', 'callback-token', exchangeRate())

    const tracker = await services.getChainTracker()
    expect(tracker).not.toBe(serviceOptions.chaintracks)
  })
})

describe('chaintracksUrlFor', () => {
  it('returns the right default URL per network when the host configured no override', () => {
    expect(chaintracksUrlFor('main')).toBe('https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('test')).toBe('https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('teratest')).toBe('https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/v1')
  })
})

// 2026-09-18: a received nosend sat unrecognised for 12 h while the explorer
// showed 6 confirmations, because proof lookups only ever asked WhatsOnChain
// and Bitails. Services builds its Arcade provider — Arcade-first getMerklePath
// and the SSE task's target — only when `arcadeUrl` is set, and these options
// never set it ("no arcadeUrl configured; SSE disabled" on every monitor start
// since the wallet was created). Every tx this wallet sends goes through
// Arcade, so Arcade must be the first place a proof is looked for.
describe('Arcade wiring', () => {
  it.each([
    ['main', 'https://arcade-v2-us-1.bsvblockchain.tech'],
    ['test', 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'],
    ['teratest', 'https://arcade-v2-ttn-us-1.bsvblockchain.tech']
  ] as const)('%s: sets arcadeUrl to the same endpoint as arcUrl, with the monitor callback token', (network, url) => {
    const options = createServiceOptions(network, 'callback-token', exchangeRate())
    expect(options.arcUrl).toBe(url)
    expect(options.arcadeUrl).toBe(url)
    expect(options.arcadeConfig?.callbackToken).toBe('callback-token')
  })

  it('an arcUrl override moves both slots together', () => {
    const options = createServiceOptions('test', 'callback-token', exchangeRate(), 'https://arcade.example')
    expect(options.arcUrl).toBe('https://arcade.example')
    expect(options.arcadeUrl).toBe('https://arcade.example')
  })

  it('Services consults Arcade first for merkle proofs', () => {
    const { services } = createServices('test', 'callback-token', exchangeRate())
    const names = (services as any).getMerklePathServices.services.map((s: { name: string }) => s.name)
    expect(names[0]).toBe('Arcade')
  })
})

// XR-066: taalApiKey silently aliased whatsOnChainApiKey on every network, so
// a host that scoped a key to WhatsOnChain unknowingly disclosed it to TAAL
// (arcadeBroadcastProvider's createTaalBroadcastService sends it as a Bearer
// token to a different origin on every ordinary broadcast).
describe('XR-066: taalApiKey must not fall back to whatsOnChainApiKey', () => {
  it.each(['main', 'test', 'teratest'] as const)(
    '%s: an omitted taalApiKey stays empty even when whatsOnChainApiKey is configured',
    network => {
      configureToolbox({
        backupUrl: null,
        services: { [network]: { whatsOnChainApiKey: 'woc-key' } as ToolboxServiceConfig }
      })
      const options = createServiceOptions(network, 'callback-token', exchangeRate())
      expect(options.whatsOnChainApiKey).toBe('woc-key')
      expect(options.taalApiKey).toBe('')
    }
  )

  it('a configured taalApiKey is still used, independent of whatsOnChainApiKey', () => {
    configureToolbox({
      backupUrl: null,
      services: { main: { whatsOnChainApiKey: 'woc-key', taalApiKey: 'taal-key' } }
    })
    const options = createServiceOptions('main', 'callback-token', exchangeRate())
    expect(options.taalApiKey).toBe('taal-key')
  })
})
