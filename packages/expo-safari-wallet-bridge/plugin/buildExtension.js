// Bundles the extension JS (spec 6.3 step 7) with esbuild into the target's Resources/ and writes the
// manifest from the template. Synchronous on purpose: apple-targets globs the target directory while
// the config plugin runs, so the files must exist by the time `withSafariBridge` returns.

const fs = require('fs')
const path = require('path')

const KIT_ROOT = path.resolve(__dirname, '..')
const SRC = path.join(KIT_ROOT, 'extension', 'src')
const TEMPLATES = path.join(KIT_ROOT, 'extension', 'templates')

const ENTRIES = {
  background: path.join(SRC, 'background.ts'),
  content: path.join(SRC, 'content.ts'),
  'provider-main': path.join(SRC, 'provider-main.ts'),
  'inject-fallback': path.join(SRC, 'inject-fallback.ts'),
  popup: path.join(SRC, 'popup', 'popup.ts')
}

// `injection` picks how the page-world script gets into the page (spec 6.8): `main-world` (default) is the
// manifest's `"world": "MAIN"` content entry; `script-tag` is the fallback, an isolated content script that adds
// `<script src>` for a web-accessible `provider-main.js` (which a strict page CSP can block).
function renderManifest({ extensionName, version, allowLocalhostHttp, injection = 'main-world' }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'manifest.json'), 'utf8'))
  const matches = ['https://*/*']
  if (allowLocalhostHttp) matches.push('http://localhost/*')
  manifest.name = extensionName
  manifest.version = version
  manifest.action.default_title = extensionName
  manifest.host_permissions = [...matches]
  for (const script of manifest.content_scripts) script.matches = [...matches]
  if (injection === 'script-tag') {
    const main = manifest.content_scripts.find(script => script.world === 'MAIN')
    manifest.content_scripts = manifest.content_scripts.filter(script => script !== main)
    const { world: _world, ...isolated } = main
    manifest.content_scripts.push({ ...isolated, js: ['inject-fallback.js'] })
    manifest.web_accessible_resources = [{ resources: ['provider-main.js'], matches: [...matches] }]
  }
  return manifest
}

function buildExtension({
  outDir,
  profile = 'release',
  allowLocalhostHttp,
  ids,
  extensionName,
  version = '1.0',
  bundleId,
  injection = 'main-world'
}) {
  const esbuild = require('esbuild')
  const localhost = allowLocalhostHttp === undefined ? profile === 'development' : Boolean(allowLocalhostHttp)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const result = esbuild.buildSync({
    entryPoints: ENTRIES,
    outdir: outDir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'safari16',
    metafile: true,
    logLevel: 'silent',
    legalComments: 'none',
    define: {
      allowLocalhostHttp: JSON.stringify(localhost),
      BRIDGE_SCHEME: JSON.stringify(ids.scheme),
      BRIDGE_NAME: JSON.stringify(extensionName),
      BRIDGE_VENDOR: JSON.stringify(String(bundleId || ids.scheme).toLowerCase())
    }
  })

  fs.copyFileSync(path.join(SRC, 'popup', 'popup.html'), path.join(outDir, 'popup.html'))
  const manifest = renderManifest({ extensionName, version, allowLocalhostHttp: localhost, injection })
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { outDir, manifest, inputs: Object.keys(result.metafile.inputs) }
}

module.exports = { buildExtension, renderManifest, ENTRIES }
