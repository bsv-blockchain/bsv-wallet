// Plan 07 Task 4: Metro resolves package exports and the ESM extensions, and
// aliases @bsv/wallet-toolbox-client to @bsv/wallet-toolbox-mobile (IC D21).
// expo/metro-config is mocked with a bare default config, so every assertion
// is about what metro.config.js itself sets.
jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({
    resolver: { sourceExts: ['js', 'ts', 'tsx', 'json'], assetExts: [], extraNodeModules: {} },
    transformer: {},
    server: {}
  })
}))

const loadConfig = () => {
  let config: any
  jest.isolateModules(() => {
    config = require('../metro.config.js')
  })
  return config
}

const ctx = () => ({
  resolveRequest: jest.fn((_c: unknown, name: string, _platform?: string) => ({ type: 'sourceFile', filePath: name }))
})

it('enables package exports', () => {
  expect(loadConfig().resolver.unstable_enablePackageExports).toBe(true)
})

it('resolves .mjs and .cjs sources', () => {
  const { sourceExts } = loadConfig().resolver
  expect(sourceExts).toContain('mjs')
  expect(sourceExts).toContain('cjs')
  expect(new Set(sourceExts).size).toBe(sourceExts.length)
})

it('aliases @bsv/wallet-toolbox-client to @bsv/wallet-toolbox-mobile (D21)', () => {
  const config = loadConfig()
  const c = ctx()
  config.resolver.resolveRequest(c, '@bsv/wallet-toolbox-client', 'ios')
  expect(c.resolveRequest).toHaveBeenCalledTimes(1)
  expect(c.resolveRequest.mock.calls[0][1]).toBe('@bsv/wallet-toolbox-mobile')
  expect(c.resolveRequest.mock.calls[0][2]).toBe('ios')
})

it('leaves other @bsv packages unaliased', () => {
  const config = loadConfig()
  for (const name of [
    '@bsv/wallet-toolbox-mobile',
    '@bsv/color-permission-module',
    '@bsv/mandala/profile',
    '@bsv/sdk'
  ]) {
    const c = ctx()
    config.resolver.resolveRequest(c, name, 'android')
    expect(c.resolveRequest.mock.calls[0][1]).toBe(name)
  }
})

it('still maps node:crypto to react-native-quick-crypto', () => {
  const config = loadConfig()
  const c = ctx()
  const res = config.resolver.resolveRequest(c, 'node:crypto', 'ios')
  expect(res.type).toBe('sourceFile')
  expect(res.filePath).toMatch(/react-native-quick-crypto/)
  expect(c.resolveRequest).not.toHaveBeenCalled()
})
