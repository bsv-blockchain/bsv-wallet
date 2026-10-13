/**
 * Guards for the identity takeover: the Bitcoin SV Wallet app ships under the
 * existing BSV Wallet's installed identity (bundle ID / package, EAS project,
 * Firebase, URL schemes, store submit identity), declares no entitlement that
 * would share wallet storage with other apps, keeps the release gates decided
 * for it, and resolves the same shared dependency versions as the existing app.
 */
const fs = require('fs')
const path = require('path')

const appDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appDir, '../..')
const existing = require(path.join(repoRoot, 'app.json')).expo
const existingEas = require(path.join(repoRoot, 'eas.json'))
const appPkg = require(path.join(appDir, 'package.json'))
const rootPkg = require(path.join(repoRoot, 'package.json'))
const eas = require(path.join(appDir, 'eas.json'))

const loadConfig = () => {
  delete require.cache[require.resolve(path.join(appDir, 'app.config.js'))]
  return require(path.join(appDir, 'app.config.js'))()
}

const asArray = v => (Array.isArray(v) ? v : v ? [v] : [])

describe('installed identity', () => {
  const config = loadConfig()

  test('bundle id, package, slug and owner are the existing app’s', () => {
    expect(config.ios.bundleIdentifier).toBe('org.bsvblockchain.wallet')
    expect(config.android.package).toBe('org.bsvblockchain.wallet')
    expect(config.ios.bundleIdentifier).toBe(existing.ios.bundleIdentifier)
    expect(config.android.package).toBe(existing.android.package)
    expect(config.slug).toBe(existing.slug)
    expect(config.owner).toBe(existing.owner)
  })

  test('registers exactly the URL schemes the existing app uses', () => {
    // With CFBundleURLTypes set, Expo ignores `scheme` on iOS.
    const iosSchemes = c =>
      new Set(
        c.ios.infoPlist.CFBundleURLTypes
          ? c.ios.infoPlist.CFBundleURLTypes.flatMap(t => t.CFBundleURLSchemes)
          : asArray(c.scheme)
      )
    const androidSchemes = c =>
      new Set([...asArray(c.scheme), ...(c.android.intentFilters ?? []).flatMap(f => f.data.map(d => d.scheme))])
    for (const schemesOf of [iosSchemes, androidSchemes]) {
      expect([...schemesOf(config)].sort()).toEqual([...schemesOf(existing)].sort())
    }
  })

  test('the link adapter resolves every wallet scheme the config registers', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/links/linkDomain', () => ({ LINK_DOMAIN: '' }))
      const { walletSchemes } = require('../app/+native-intent')
      expect([...walletSchemes].sort()).toEqual([...asArray(config.scheme)].sort())
    })
  })

  test('uses the existing app’s EAS project and Firebase registrations', () => {
    expect(config.extra.eas.projectId).toBe(existing.extra.eas.projectId)
    expect(path.resolve(appDir, config.ios.googleServicesFile)).toBe(
      path.resolve(repoRoot, existing.ios.googleServicesFile)
    )
    expect(path.resolve(appDir, config.android.googleServicesFile)).toBe(
      path.resolve(repoRoot, existing.android.googleServicesFile)
    )
  })
})

describe('no shared persisted state', () => {
  const config = loadConfig()

  test('no keychain access group, app group or other sharing entitlement', () => {
    const allowed = new Set(['aps-environment', 'com.apple.developer.associated-domains'])
    for (const key of Object.keys(config.ios.entitlements ?? {})) expect(allowed.has(key)).toBe(true)
  })

  test('no Android shared user id and no OS cloud backup', () => {
    expect(config.android.sharedUserId).toBeUndefined()
    expect(config.android.allowBackup).toBe(false)
  })
})

describe('release gates', () => {
  const env = name => {
    // Resolve `extends` chains the way EAS does (child env overrides parent).
    const profile = eas.build[name]
    const parent = profile.extends ? env(profile.extends) : {}
    return { ...parent, ...(profile.env ?? {}) }
  }

  test('Vault is on in development and preview builds only', () => {
    for (const p of ['development', 'dev-physical', 'preview', 'preview-apk']) {
      expect(env(p).EXPO_PUBLIC_VAULT_ENABLED).toBe('true')
    }
    expect(env('production').EXPO_PUBLIC_VAULT_ENABLED).not.toBe('true')
  })

  // Decision 13 (2026-10-09): production push via MessageBox. It only wires in
  // once this app's own Firebase registration exists (app.config.js).
  test('push is enabled in every profile', () => {
    for (const p of Object.keys(eas.build).filter(p => p !== 'base')) {
      expect(env(p).EXPO_PUBLIC_PUSH_ENABLED).toBe('true')
    }
  })

  // Decision 7: production handles live under bitcoinsv.com.
  test('production handles are registered under bitcoinsv.com', () => {
    expect(env('production').EXPO_PUBLIC_HANDLE_REGISTRY_DOMAIN).toBe('bitcoinsv.com')
  })

  test('submits to the existing app’s App Store listing', () => {
    expect(eas.submit).toEqual(existingEas.submit)
  })
})

describe('shared dependencies', () => {
  // Both shells must resolve one copy of every native module and of the shared
  // wallet core. A version that differs from the root would make npm install a
  // second copy under apps/bitcoinsv/node_modules.
  test('every dependency matches the existing app’s declared version', () => {
    const normalise = v => v.replace(/^file:(\.\.\/\.\.\/|\.\/)?/, 'file:')
    for (const [name, version] of Object.entries(appPkg.dependencies)) {
      if (!(name in rootPkg.dependencies)) continue
      expect([name, normalise(version)]).toEqual([name, normalise(rootPkg.dependencies[name])])
    }
  })

  test('the app is a workspace of the repository root', () => {
    expect(rootPkg.workspaces).toContain('apps/*')
    expect(fs.existsSync(path.join(appDir, 'node_modules'))).toBe(false)
  })
})
