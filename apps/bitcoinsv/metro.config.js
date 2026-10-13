// Metro config for the Bitcoin SV Wallet app.
//
// This app is an npm workspace of the repository root: every dependency,
// including the shared wallet core under packages/ and the patch-package
// patches, is installed once in the root node_modules. Resolving only from
// there guarantees both apps bundle the same patched modules.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Inline requires: a module is loaded where it's first used, not all at once
// before the first screen (React Native's startup optimisation; Expo leaves it
// off). Side-effect imports (the crypto bootstrap in index.js) keep their order.
const upstreamTransformOptions = config.transformer.getTransformOptions
config.transformer.getTransformOptions = async (...args) => {
  const base = upstreamTransformOptions ? await upstreamTransformOptions(...args) : {}
  return { ...base, transform: { ...(base.transform ?? {}), inlineRequires: true } }
}

config.watchFolders = [repoRoot]
config.resolver.nodeModulesPaths = [path.join(repoRoot, 'node_modules')]

// Never crawl git worktrees (each has its own node_modules) or the generated
// native projects of either app.
const existingBlockList = config.resolver.blockList
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  /\/\.claude\/worktrees\/.*/,
  /\/\.worktrees\/.*/,
  /\/ios\/Pods\/.*/,
  /\/apps\/[^/]+\/(ios|android)\/.*/
]

// Crypto polyfills, as in the existing app's metro.config.js.
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

const emptyShim = path.join(repoRoot, 'metro-shims/empty.js')
const quickCryptoMain = require.resolve('react-native-quick-crypto')

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // node:crypto → react-native-quick-crypto so the SDK uses native SHA256/PBKDF2/AES-GCM.
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: quickCryptoMain }
  }
  if (moduleName === 'node:buffer' || moduleName === 'node:process') {
    return { type: 'sourceFile', filePath: emptyShim }
  }
  if (typeof upstream === 'function') return upstream(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

config.transformer.assetPlugins = ['expo-asset/tools/hashAssetFiles']

module.exports = config
