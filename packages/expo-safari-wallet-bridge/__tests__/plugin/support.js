// Test harness: runs the plugin against a fake config and executes the mods it registered.
const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('expo/config-plugins', () => {
  const record = (name, config, fn) => {
    config.__mods = { ...(config.__mods || {}), [name]: fn }
    return config
  }
  return {
    ...jest.requireActual('expo/config-plugins'),
    withEntitlementsPlist: (config, fn) => record('entitlements', config, fn),
    withInfoPlist: (config, fn) => record('infoPlist', config, fn),
    withPodfile: (config, fn) => record('podfile', config, fn)
  }
})

const withSafariBridge = require('../../plugin')

function fixtureConfig(projectRoot, extra = {}) {
  return {
    name: 'Wallet',
    slug: 'wallet',
    version: '1.2.3',
    sdkVersion: '57.0.0',
    ios: { bundleIdentifier: 'org.bsvblockchain.wallet', appleTeamId: 'SV8SWTHA2H' },
    _internal: { projectRoot },
    ...extra
  }
}

function run({ entitlements = {}, infoPlist = {}, podfile, options = {}, config = {} } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-bridge-test-'))
  const out = withSafariBridge(fixtureConfig(projectRoot, config), { extensionName: 'Bitcoin SV Wallet', ...options })
  const mods = out.__mods
  const result = {
    projectRoot,
    config: out,
    targetDir: path.join(projectRoot, '.expo', 'safari-bridge', 'SafariBridge')
  }
  result.entitlements = mods.entitlements({ modResults: JSON.parse(JSON.stringify(entitlements)) }).modResults
  result.infoPlist = mods.infoPlist({ modResults: JSON.parse(JSON.stringify(infoPlist)) }).modResults
  const source = podfile || "target 'Wallet' do\n  use_expo_modules!\nend\n"
  result.podfile = mods.podfile({
    modResults: { contents: source },
    modRequest: { projectName: 'Wallet', platformProjectRoot: path.join(projectRoot, 'ios') }
  }).modResults.contents
  return result
}

module.exports = { run }
