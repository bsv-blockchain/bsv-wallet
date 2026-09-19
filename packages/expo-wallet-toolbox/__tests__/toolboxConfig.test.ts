import {
  configureToolbox,
  getBackupUrl,
  getHandleCertifierConfig,
  getHandleRegistryConfig,
  getServiceConfig,
  isToolboxConfigured,
  isVaultAvailable,
  isVaultEnabled,
  resetToolboxConfig
} from '../core/toolboxConfig'

afterEach(() => {
  resetToolboxConfig()
})

describe('configureToolbox', () => {
  it('reports whether the host has configured the toolbox', () => {
    expect(isToolboxConfigured()).toBe(false)
    configureToolbox({ backupUrl: null })
    expect(isToolboxConfigured()).toBe(true)
  })

  it('strips trailing slashes from the backup origin', () => {
    configureToolbox({ backupUrl: 'https://backup.example.com///' })
    expect(getBackupUrl()).toBe('https://backup.example.com')
  })

  it('treats null as a deliberate opt-out, reported as an empty URL', () => {
    configureToolbox({ backupUrl: null })
    expect(getBackupUrl()).toBe('')
  })

  it('rejects a backup URL with a path, which would break the BRC-103 handshake', () => {
    expect(() => configureToolbox({ backupUrl: 'https://backup.example.com/api' })).toThrow(/no path/)
  })

  it('rejects a backup URL carrying a query or fragment', () => {
    expect(() => configureToolbox({ backupUrl: 'https://backup.example.com?x=1' })).toThrow(/bare origin/)
    expect(() => configureToolbox({ backupUrl: 'https://backup.example.com#x' })).toThrow(/bare origin/)
  })

  it('rejects a value that is not a URL at all', () => {
    expect(() => configureToolbox({ backupUrl: 'backup.example.com' })).toThrow(/not a valid URL/)
  })

  it('replaces the previous configuration wholesale rather than merging', () => {
    configureToolbox({ backupUrl: 'https://a.example.com', services: { main: { arcUrl: 'https://arc.a' } } })
    configureToolbox({ backupUrl: 'https://b.example.com' })
    expect(getBackupUrl()).toBe('https://b.example.com')
    expect(getServiceConfig('main')).toEqual({})
  })
})

// The whole point of this seam: a host that upgrades without configuring must
// fail loudly. Returning '' here would reproduce the silent node_modules
// env-inlining bug this module exists to close.
describe('unconfigured access', () => {
  it('throws on getBackupUrl, instead of quietly behaving like a disabled build', () => {
    expect(() => getBackupUrl()).toThrow(/not configured/)
  })

  it('throws on getServiceConfig', () => {
    expect(() => getServiceConfig('main')).toThrow(/not configured/)
  })

  it('names the fix in the error message', () => {
    expect(() => getBackupUrl()).toThrow(/configureToolbox/)
  })
})

describe('getServiceConfig', () => {
  it('returns the host values for a configured chain', () => {
    configureToolbox({
      backupUrl: null,
      services: { test: { arcUrl: 'https://arc.test', whatsOnChainApiKey: 'k' } }
    })
    expect(getServiceConfig('test')).toEqual({ arcUrl: 'https://arc.test', whatsOnChainApiKey: 'k' })
  })

  it('returns an empty object for a chain the host said nothing about', () => {
    configureToolbox({ backupUrl: null, services: { main: { arcUrl: 'https://arc.main' } } })
    expect(getServiceConfig('teratest')).toEqual({})
  })
})

// No handle certifier is deployed anywhere this package can reach as of
// 2026-09 (core/identity/handleCertificate.ts), so this getter must default to
// undefined without throwing — the registration UI reads that as "not
// available yet", the same posture getMandalaEndpoints already has.
describe('getHandleCertifierConfig', () => {
  const VALID_KEY = '02' + 'aa'.repeat(32)

  it('is undefined before configureToolbox runs, without throwing', () => {
    expect(getHandleCertifierConfig('main')).toBeUndefined()
  })

  it('is undefined for a chain the host said nothing about', () => {
    configureToolbox({ backupUrl: null })
    expect(getHandleCertifierConfig('main')).toBeUndefined()
  })

  it('returns the configured certifier for a chain with a valid entry', () => {
    configureToolbox({
      backupUrl: null,
      handleCertifier: { test: { certifierIdentityKey: VALID_KEY, certifierUrl: 'https://certifier.example///' } }
    })
    expect(getHandleCertifierConfig('test')).toEqual({
      certifierIdentityKey: VALID_KEY,
      certifierUrl: 'https://certifier.example'
    })
  })

  it('rejects a malformed identity key rather than handing it to acquireCertificate', () => {
    configureToolbox({
      backupUrl: null,
      handleCertifier: { test: { certifierIdentityKey: 'not-a-key', certifierUrl: 'https://certifier.example' } }
    })
    expect(getHandleCertifierConfig('test')).toBeUndefined()
  })
})

// The registry is a deployment fact this package cannot guess, so an
// unconfigured chain must read as "not available yet" to the Profile screen and
// as "no registry tier" to Pay — never as a crash, and never as a half-usable
// entry pointing at a host that is not the domain's registry.
describe('getHandleRegistryConfig', () => {
  it('is undefined before configureToolbox runs, without throwing', () => {
    expect(getHandleRegistryConfig('main')).toBeUndefined()
  })

  it('is undefined for a chain the host said nothing about', () => {
    configureToolbox({ backupUrl: null })
    expect(getHandleRegistryConfig('main')).toBeUndefined()
  })

  it('lowercases the domain and strips trailing slashes from the url', () => {
    configureToolbox({
      backupUrl: null,
      handleRegistry: { test: { domain: '  Deggen.COM ', url: 'https://messagebox.bsvblockchain.tech///' } }
    })
    expect(getHandleRegistryConfig('test')).toEqual({
      domain: 'deggen.com',
      url: 'https://messagebox.bsvblockchain.tech'
    })
  })

  it.each([
    ['an empty domain', { domain: '', url: 'https://registry.example' }],
    ['a domain with no dot', { domain: 'deggen', url: 'https://registry.example' }],
    ['a domain with a scheme', { domain: 'https://deggen.com', url: 'https://registry.example' }],
    ['an empty url', { domain: 'deggen.com', url: '' }],
    ['a url that is not a url', { domain: 'deggen.com', url: 'registry.example' }],
    ['plain http to a public host', { domain: 'deggen.com', url: 'http://registry.example' }],
    // The url is an origin that request paths are appended to
    // (`${url}/api/handle/dee`), so anything after the host makes every route
    // it builds a different URL than the one the host meant — the same reason
    // `normalizeBackupUrl` refuses these.
    ['a url with a path', { domain: 'deggen.com', url: 'https://registry.example/api' }],
    ['a url with a query', { domain: 'deggen.com', url: 'https://registry.example?x=1' }],
    ['a url with a fragment', { domain: 'deggen.com', url: 'https://registry.example#a' }]
  ])('treats %s as no registry at all', (_label, entry) => {
    configureToolbox({ backupUrl: null, handleRegistry: { test: entry } })
    expect(getHandleRegistryConfig('test')).toBeUndefined()
  })

  // Development only: a registry on the machine running the simulator, or on
  // the Android emulator's host alias. Anything public must be https, because
  // which key owns a handle is exactly what TLS is protecting here.
  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://10.0.2.2:8080',
    'http://192.168.1.50:8080',
    'http://172.16.4.4:8080'
  ])('allows %s for development', url => {
    configureToolbox({ backupUrl: null, handleRegistry: { test: { domain: 'deggen.com', url } } })
    expect(getHandleRegistryConfig('test')).toEqual({ domain: 'deggen.com', url })
  })

  it('is replaced wholesale with the rest of the configuration', () => {
    configureToolbox({
      backupUrl: null,
      handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
    })
    configureToolbox({ backupUrl: null })
    expect(getHandleRegistryConfig('test')).toBeUndefined()
  })
})

// The vault release gate (spec §0 / D15). Default off; on only when the host
// says so; and — unlike the URL getters — never throws, because the home
// screen reads it while rendering and an unconfigured dev host must simply
// see "no vault", not a crash.
describe('isVaultEnabled', () => {
  it('is false before configureToolbox runs, without throwing', () => {
    expect(isVaultEnabled()).toBe(false)
  })

  it('defaults to false when the host omits it', () => {
    configureToolbox({ backupUrl: null })
    expect(isVaultEnabled()).toBe(false)
  })

  it('is true when the host passes true', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    expect(isVaultEnabled()).toBe(true)
  })

  it('is replaced wholesale with the rest of the configuration', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    configureToolbox({ backupUrl: null })
    expect(isVaultEnabled()).toBe(false)
  })
})

// Vault is mainnet-only (task 11): a testnet vault would let the enrollment
// wizard's factory-reset offer wipe a YubiKey that is a live mainnet signer,
// because the enrolled-key list it reads is namespaced per (wallet, chain)
// while the key itself is one physical object.
describe('isVaultAvailable', () => {
  it('is true only on main with the flag on', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    expect(isVaultAvailable('main')).toBe(true)
  })

  it('is false on every test chain even with the flag on', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    expect(isVaultAvailable('test')).toBe(false)
    expect(isVaultAvailable('teratest')).toBe(false)
  })

  it('is false on every chain with the flag off', () => {
    configureToolbox({ backupUrl: null })
    expect(isVaultAvailable('main')).toBe(false)
    expect(isVaultAvailable('test')).toBe(false)
    expect(isVaultAvailable('teratest')).toBe(false)
  })

  it('is false before configureToolbox runs, without throwing', () => {
    expect(isVaultAvailable('main')).toBe(false)
  })
})
