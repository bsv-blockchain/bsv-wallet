/** @jest-environment node */
const { validate } = require('../../plugin/validate')

const good = () => ({
  sdkVersion: '57.0.0',
  ios: { bundleIdentifier: 'org.bsvblockchain.wallet', appleTeamId: 'SV8SWTHA2H' }
})
const opts = () => ({ extensionName: 'Bitcoin SV Wallet' })
const deps = { resolve: () => '/x' }

describe('validate', () => {
  test('passes for a complete configuration', () => {
    expect(validate(good(), opts(), deps)).toEqual({ teamId: 'SV8SWTHA2H' })
  })

  test('validate fails loudly for missing bundle id, team id, wrong SDK, missing apple-targets and an extensionName outside 1 to 80 UTF-8 bytes', () => {
    const noBundle = good()
    delete noBundle.ios.bundleIdentifier
    expect(() => validate(noBundle, opts(), deps)).toThrow('SafariBridge: ios.bundleIdentifier is required')

    const noTeam = good()
    delete noTeam.ios.appleTeamId
    expect(() => validate(noTeam, opts(), deps)).toThrow(/SafariBridge: appleTeamId/)
    expect(validate(noTeam, { ...opts(), appleTeamId: 'ABCDE12345' }, deps).teamId).toBe('ABCDE12345')

    expect(() => validate({ ...good(), sdkVersion: '56.0.0' }, opts(), deps)).toThrow(/SafariBridge: Expo SDK 57/)

    const missing = {
      resolve: () => {
        throw new Error('not found')
      }
    }
    expect(() => validate(good(), opts(), missing)).toThrow(/SafariBridge: @bacons\/apple-targets/)

    expect(() => validate(good(), { extensionName: '' }, deps)).toThrow(/extensionName/)
    expect(() => validate(good(), {}, deps)).toThrow(/extensionName/)
    expect(() => validate(good(), { extensionName: 'a'.repeat(81) }, deps)).toThrow(/extensionName/)
    expect(() => validate(good(), { extensionName: 'é'.repeat(41) }, deps)).toThrow(/extensionName/)
    expect(() => validate(good(), { extensionName: 'a'.repeat(80) }, deps)).not.toThrow()
    expect(() => validate(good(), { extensionName: 'é'.repeat(40) }, deps)).not.toThrow()
  })

  test('a missing Podfile anchor is a named error', () => {
    const { wirePodfile } = require('../../plugin')
    expect(() => wirePodfile("target 'Other' do\nend\n", { projectName: 'Wallet', podPath: '../p' })).toThrow(
      /SafariBridge: anchor "target 'Wallet' do"/
    )
  })

  test('the Podfile wiring is idempotent and matches the app target use_frameworks', () => {
    const { wirePodfile } = require('../../plugin')
    const podfile = "target 'Wallet' do\n  use_expo_modules!\nend\n"
    const once = wirePodfile(podfile, { projectName: 'Wallet', podPath: '../p' })
    expect(once).toContain("target 'Wallet' do\n  pod 'BsvBridgeQueue', :path => '../p'\n")
    expect(once).toContain("target 'SafariBridge' do\n  use_frameworks!")
    expect(wirePodfile(once, { projectName: 'Wallet', podPath: '../p' })).toBe(once)
  })
})
