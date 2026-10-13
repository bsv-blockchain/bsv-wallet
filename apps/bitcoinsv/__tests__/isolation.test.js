/**
 * Guards for the two-app contract (docs/superpowers/2026-10-09-now-app-handover.md):
 * the Bitcoin SV Wallet app must have its own installed identity and share no
 * persisted state, links or release identity with the existing BSV Wallet app,
 * must keep the release gates decided for it, and must resolve the same shared
 * dependency versions as the existing app.
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

  test('bundle id, package, slug and name are this app’s own', () => {
    expect(config.ios.bundleIdentifier).toBe('com.bitcoinsv.wallet')
    expect(config.android.package).toBe('com.bitcoinsv.wallet')
    expect(config.ios.bundleIdentifier).not.toBe(existing.ios.bundleIdentifier)
    expect(config.android.package).not.toBe(existing.android.package)
    expect(config.slug).not.toBe(existing.slug)
    expect(config.name).not.toBe(existing.name)
  })

  test('registers no URL scheme the existing app uses', () => {
    const existingSchemes = new Set([
      ...asArray(existing.scheme),
      ...(existing.ios.infoPlist.CFBundleURLTypes ?? []).flatMap(t => t.CFBundleURLSchemes),
      ...(existing.android.intentFilters ?? []).flatMap(f => f.data.map(d => d.scheme))
    ])
    const schemes = [
      ...asArray(config.scheme),
      ...(config.ios.infoPlist.CFBundleURLTypes ?? []).flatMap(t => t.CFBundleURLSchemes),
      ...(config.android.intentFilters ?? []).flatMap(f => f.data.map(d => d.scheme))
    ]
    expect(schemes).toEqual(['bitcoinsv-wallet'])
    for (const s of schemes) expect(existingSchemes.has(s)).toBe(false)
  })

  test('never shares the existing app’s EAS project', () => {
    const projectId = config.extra?.eas?.projectId
    expect(projectId).not.toBe(existing.extra.eas.projectId)
  })
})

describe('no shared persisted state', () => {
  const config = loadConfig()

  test('no keychain access group, app group or other sharing entitlement', () => {
    const allowed = new Set(['aps-environment'])
    for (const key of Object.keys(config.ios.entitlements ?? {})) expect(allowed.has(key)).toBe(true)
  })

  test('no Android shared user id and no OS cloud backup', () => {
    expect(config.android.sharedUserId).toBeUndefined()
    expect(config.android.allowBackup).toBe(false)
  })

  test('any Firebase registration belongs to this app, not the existing one', () => {
    const plist = path.join(appDir, 'firebase/GoogleService-Info.plist')
    const json = path.join(appDir, 'firebase/google-services.json')
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, 'utf8')
      expect(text).toContain('<string>com.bitcoinsv.wallet</string>')
      expect(text).not.toContain(existing.ios.bundleIdentifier)
    }
    if (fs.existsSync(json)) {
      const clients = JSON.parse(fs.readFileSync(json, 'utf8')).client ?? []
      const packages = clients.map(c => c.client_info?.android_client_info?.package_name)
      expect(packages).toContain('com.bitcoinsv.wallet')
      expect(packages).not.toContain(existing.android.package)
    }
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

  test('profiles are this app’s own, with no submit identity copied from the existing app', () => {
    expect(eas.submit).toBeUndefined()
    expect(JSON.stringify(eas)).not.toContain(existingEas.submit.production.ios.ascAppId)
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
