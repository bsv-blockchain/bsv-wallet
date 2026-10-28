/** @jest-environment node */
const fs = require('fs')
const path = require('path')
const { run } = require('./support')

describe('plugin output', () => {
  test('snapshot of app entitlements, appex entitlements, Info.plist, target settings, EAS appExtensions', () => {
    const out = run({
      entitlements: { 'com.apple.developer.nfc.readersession.formats': ['TAG'] },
      infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['bsv-wallet'] }] }
    })
    const settings = JSON.parse(fs.readFileSync(path.join(out.targetDir, 'bridge-target.json'), 'utf8'))
    expect({
      appEntitlements: out.entitlements,
      appInfoPlist: out.infoPlist,
      targetSettings: settings,
      appexInfoPlist: fs.readFileSync(path.join(out.targetDir, 'Info.plist'), 'utf8'),
      easAppExtensions: out.config.extra.eas.build.experimental.ios.appExtensions,
      podfile: out.podfile.replace(/:path => '[^']*'/g, ":path => '<kit>/swift/BsvBridgeQueue'")
    }).toMatchSnapshot()
  })

  test('the appex entitlements carry only the bridge keychain group and the data protection default', () => {
    const out = run({})
    const { entitlements } = JSON.parse(fs.readFileSync(path.join(out.targetDir, 'bridge-target.json'), 'utf8'))
    expect(entitlements['keychain-access-groups']).toEqual(['$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge'])
    expect(entitlements['com.apple.developer.default-data-protection']).toBe(
      'NSFileProtectionCompleteUntilFirstUserAuthentication'
    )
  })

  test('the handler template answers through handleBridgeMessage', () => {
    const out = run({})
    const swift = fs.readFileSync(path.join(out.targetDir, 'SafariWebExtensionHandler.swift'), 'utf8')
    expect(swift).toContain('handleBridgeMessage(request, env: env)')
    expect(swift).not.toContain('org.bsvblockchain')
  })

  test('the deployment target follows expo-build-properties', () => {
    const out = run({ config: { plugins: [['expo-build-properties', { ios: { deploymentTarget: '17.2' } }]] } })
    const settings = JSON.parse(fs.readFileSync(path.join(out.targetDir, 'bridge-target.json'), 'utf8'))
    expect(settings.deploymentTarget).toBe('17.2')
  })
})
