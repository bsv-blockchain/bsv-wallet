/** @jest-environment node */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { run } = require('./support')

// A host like bitcoin-sv-wallet: the NFC entitlement from another plugin and three existing schemes.
const hostEntitlements = () => ({
  'com.apple.developer.nfc.readersession.formats': ['TAG', 'NDEF'],
  'com.apple.security.application-groups': ['group.other.thing']
})
const hostPlist = () => ({
  CFBundleURLTypes: [
    { CFBundleURLSchemes: ['bsv-wallet'] },
    { CFBundleURLSchemes: ['bsv'] },
    { CFBundleURLName: 'pay', CFBundleURLSchemes: ['bitcoin'] }
  ],
  NSCameraUsageDescription: 'Scan'
})

describe('host output', () => {
  test("the plugin changes nothing about the host's existing entitlements, URL types and other plugins' output", () => {
    const out = run({ entitlements: hostEntitlements(), infoPlist: hostPlist() })
    const ents = out.entitlements
    expect(ents['com.apple.developer.nfc.readersession.formats']).toEqual(['TAG', 'NDEF'])
    expect(ents['com.apple.security.application-groups']).toEqual([
      'group.other.thing',
      'group.org.bsvblockchain.wallet'
    ])
    const plist = out.infoPlist
    expect(plist.CFBundleURLTypes.slice(0, 3)).toEqual(hostPlist().CFBundleURLTypes)
    expect(plist.CFBundleURLTypes).toHaveLength(4)
    expect(plist.NSCameraUsageDescription).toBe('Scan')
    expect(fs.existsSync(path.join(out.projectRoot, 'targets'))).toBe(false)
  })

  test('app keychain groups are exactly [host, host.bridge] in that order', () => {
    const out = run({})
    expect(out.entitlements['keychain-access-groups']).toEqual([
      '$(AppIdentifierPrefix)org.bsvblockchain.wallet',
      '$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge'
    ])
    const again = run({
      entitlements: { 'keychain-access-groups': ['$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge'] }
    })
    expect(again.entitlements['keychain-access-groups']).toEqual([
      '$(AppIdentifierPrefix)org.bsvblockchain.wallet',
      '$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge'
    ])
  })

  test('app groups merge and never replace an existing value', () => {
    const out = run({
      entitlements: { 'com.apple.security.application-groups': ['group.a', 'group.org.bsvblockchain.wallet'] }
    })
    expect(out.entitlements['com.apple.security.application-groups']).toEqual([
      'group.a',
      'group.org.bsvblockchain.wallet'
    ])
  })

  test('running twice does not duplicate the URL type', () => {
    const first = run({})
    const second = run({ infoPlist: first.infoPlist })
    expect(
      second.infoPlist.CFBundleURLTypes.filter(t => t.CFBundleURLName === 'org.bsvblockchain.wallet.bridge')
    ).toHaveLength(1)
  })

  test('no process.env in plugin/', () => {
    const dir = path.join(__dirname, '..', '..', 'plugin')
    for (const file of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/process\.env/)
    }
    expect(os.tmpdir()).toBeTruthy()
  })
})
