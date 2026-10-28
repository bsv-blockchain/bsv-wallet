/** @jest-environment node */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildExtension } = require('../../plugin/buildExtension')
const { deriveIds } = require('../../plugin/ids')

const B = 'org.bsvblockchain.wallet'
const build = (profile, extra = {}) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-bridge-build-'))
  const result = buildExtension({
    outDir,
    profile,
    ids: deriveIds(B),
    bundleId: B,
    extensionName: 'Bitcoin SV Wallet',
    ...extra
  })
  return { outDir, ...result }
}

describe('buildExtension', () => {
  test('manifest permissions equal exactly nativeMessaging, storage, tabs', () => {
    const { manifest } = build('release')
    expect(manifest.manifest_version).toBe(3)
    expect([...manifest.permissions].sort()).toEqual(['nativeMessaging', 'storage', 'tabs'])
    expect(manifest.background).toEqual({ scripts: ['background.js'], persistent: false })
    expect(manifest.host_permissions).toEqual(['https://*/*'])
    expect(manifest.content_scripts).toHaveLength(2)
    for (const script of manifest.content_scripts) {
      expect(script.all_frames).toBe(true)
      expect(script.run_at).toBe('document_start')
      expect(script.matches).toEqual(['https://*/*'])
    }
    expect(manifest.content_scripts[0].world).toBeUndefined()
    expect(manifest.content_scripts[1]).toMatchObject({ js: ['provider-main.js'], world: 'MAIN' })
  })

  test('development profile adds http://localhost/* and sets allowLocalhostHttp; release does not', () => {
    const dev = build('development')
    expect(dev.manifest.host_permissions).toEqual(['https://*/*', 'http://localhost/*'])
    expect(dev.manifest.content_scripts[0].matches).toContain('http://localhost/*')
    expect(fs.readFileSync(path.join(dev.outDir, 'background.js'), 'utf8')).toMatch(/localhostHttp: true/)

    const release = build('release')
    expect(JSON.stringify(release.manifest)).not.toContain('localhost')
    expect(fs.readFileSync(path.join(release.outDir, 'background.js'), 'utf8')).toMatch(/localhostHttp: false/)
  })

  test('built Resources contain the three scripts, the MAIN-world content entry and no @bsv/expo-wallet-toolbox app import', () => {
    const { outDir, inputs } = build('release')
    for (const file of ['background.js', 'content.js', 'provider-main.js', 'popup.js', 'popup.html', 'manifest.json']) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true)
    }
    for (const file of ['background.js', 'content.js', 'provider-main.js', 'popup.js']) {
      const text = fs.readFileSync(path.join(outDir, file), 'utf8')
      // 'react-native' is also a BRC-185 endpoint type name in the descriptor validator; what must not appear is the package.
      expect(text).not.toMatch(/react-native\/|["']react-native["']\)|from ["']react-native["']/)
      expect(text).not.toContain('node_modules/react-native')
      expect(text).not.toContain('__DEV__')
      expect(text).not.toContain('errorCodec')
      expect(text).not.toMatch(/process\.env/)
    }
    // Only the extension sources and P1's pure protocol modules are bundled from the toolbox.
    const toolbox = inputs.filter(input => input.includes('expo-wallet-toolbox'))
    expect(toolbox.length).toBeGreaterThan(0)
    // `protocol/origin.ts` imports `../unverifiedOriginator.ts`, itself pure (it imports only `protocol/limits`).
    for (const input of toolbox) {
      expect(input).toMatch(/core\/bridge\/(protocol\/[a-zA-Z0-9]+|unverifiedOriginator)\.ts$/)
    }
    expect(toolbox.some(input => input.includes('errorCodec') || input.includes('core/config'))).toBe(false)
  })

  test('the build constants are replaced in the bundle', () => {
    const { outDir } = build('release')
    const text = fs.readFileSync(path.join(outDir, 'background.js'), 'utf8')
    expect(text).toContain('"org.bsvblockchain.wallet"')
    expect(text).toContain('"Bitcoin SV Wallet"')
    expect(text).not.toMatch(/\bBRIDGE_SCHEME\b/)
  })
})
