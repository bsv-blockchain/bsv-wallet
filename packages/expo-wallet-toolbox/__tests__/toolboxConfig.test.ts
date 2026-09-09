import {
  configureToolbox,
  getBackupUrl,
  getServiceConfig,
  isToolboxConfigured,
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
