// Standalone build for development: `node extension/build.mjs <outDir> [development|release]`.
// The config plugin calls the same code at prebuild.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { buildExtension } = require('../plugin/buildExtension.js')
const { deriveIds } = require('../plugin/ids.js')

const [outDir = 'build/Resources', profile = 'development', bundleId = 'org.bsvblockchain.wallet'] =
  process.argv.slice(2)
const result = buildExtension({
  outDir: path.resolve(outDir),
  profile,
  ids: deriveIds(bundleId),
  bundleId,
  extensionName: 'Bitcoin SV Wallet'
})
console.log(`built ${result.inputs.length} inputs into ${result.outDir}`)
