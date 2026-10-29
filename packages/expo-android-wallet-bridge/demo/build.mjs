// Bundles main.ts into .build/demo/ (git-ignored). Run: node demo/build.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

export const OUT_DIR = path.resolve(here, '..', '.build', 'demo')

export function buildDemo(outDir = OUT_DIR) {
  fs.mkdirSync(outDir, { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(here, 'main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome100',
    outfile: path.join(outDir, 'demo.js'),
    // Same shim as the iOS demo build: the vendored fast snippets import brc29ProtocolID from the full toolbox client.
    alias: {
      '@bsv/wallet-toolbox-client': path.resolve(
        here,
        '..',
        '..',
        'expo-safari-wallet-bridge',
        'demo',
        'conformance',
        'shims',
        'walletToolboxClient.ts'
      )
    },
    logLevel: 'silent'
  })
  fs.copyFileSync(path.join(here, 'index.html'), path.join(outDir, 'index.html'))
  return outDir
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`built demo into ${buildDemo(path.resolve(process.argv[2] ?? OUT_DIR))}`)
}
