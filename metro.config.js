const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

// Git worktrees live INSIDE the project root (.claude/worktrees/<branch>/ and
// .worktrees/<branch>/), each with its own full node_modules. Metro crawls the
// project root, so without this it walks every worktree's dependency tree —
// which both bloats the file map and hard-fails the bundler ("TreeFS: Could not
// add directory ... already exists in the file map as a file") when two crawled
// copies of a package disagree about whether a path is a file or a directory.
//
// Keep this a blockList rather than trimming watchFolders: the worktrees are
// under the project root itself, so they are not separate watch folders to drop.
const existingBlockList = config.resolver.blockList
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  /\/\.claude\/worktrees\/.*/,
  /\/\.worktrees\/.*/
]

// Crypto polyfills
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

// 1Color packages (@bsv/color-permission-module, @bsv/mandala, @bsv/templates)
// are ESM-only or exports-first: their entry points live under `exports` and
// end in .mjs/.cjs. Expo's default config already turns both on; set them here
// explicitly so a default change upstream cannot silently break resolution.
config.resolver.unstable_enablePackageExports = true
for (const ext of ['mjs', 'cjs']) {
  if (!config.resolver.sourceExts.includes(ext)) config.resolver.sourceExts.push(ext)
}

// IC D21: @bsv/color-permission-module imports @bsv/wallet-toolbox-client
// values. On React Native that is the same toolbox as -mobile, so alias the
// exact name (no fork, one toolbox instance in the bundle).
const MODULE_ALIASES = {
  '@bsv/wallet-toolbox-client': '@bsv/wallet-toolbox-mobile'
}

const emptyShim = path.resolve(__dirname, 'metro-shims/empty.js')
const quickCryptoMain = require.resolve('react-native-quick-crypto')

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Route node:crypto → react-native-quick-crypto so SDK uses native SHA256/PBKDF2/AES-GCM.
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: quickCryptoMain }
  }
  if (moduleName === 'node:buffer' || moduleName === 'node:process') {
    return { type: 'sourceFile', filePath: emptyShim }
  }
  if (Object.prototype.hasOwnProperty.call(MODULE_ALIASES, moduleName)) {
    moduleName = MODULE_ALIASES[moduleName]
  }
  if (typeof upstream === 'function') return upstream(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

// Add wasm support for expo-sqlite on web
config.resolver.assetExts.push('wasm')
config.transformer.assetPlugins = ['expo-asset/tools/hashAssetFiles']

// Add COEP and COOP headers required for SharedArrayBuffer (used by expo-sqlite on web)
config.server = config.server || {}
const originalEnhanceMiddleware = config.server.enhanceMiddleware
config.server.enhanceMiddleware = middleware => {
  const enhanced = originalEnhanceMiddleware ? originalEnhanceMiddleware(middleware) : middleware
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    return enhanced(req, res, next)
  }
}

module.exports = config
