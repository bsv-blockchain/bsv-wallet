#!/usr/bin/env node
// Vendor the unpublished 1Color packages (IC §9) into vendor/ and point the
// root package.json at them.
//
// Usage: node scripts/vendor-1color.mjs [--src <dir>] [--allow-missing]
//
// For each vendored name it picks the newest-mtime `bsv-<pkg>-<ver>-<sha>.tgz`
// in --src (default: the mandala 1color worktree's vendor-ts-stack/), copies it
// to vendor/, deletes every other tarball of that package from vendor/, and
// sets root `dependencies[name] = "file:vendor/<file>"` and
// `overrides[name] = "$<name>"`. It sets the 1Color peer ranges on
// packages/expo-wallet-toolbox (which keeps semver peers, never file: specs).
// When @bsv/mandala is vendored it also deletes patches/@bsv+mandala+*.patch.
//
// Strict by default: if any name has no tarball it changes nothing and exits 1.
// --allow-missing (V0 bring-up, IC §10) leaves a name with no tarball exactly as
// it is (spec, vendor file and patch) and still vendors the rest. Re-run it,
// strict, whenever a newer pack lands, then `npm install`.
//
// Plain Node, no dependencies. Safe to re-run: an identical tarball is not
// re-copied, and every write goes through a temp file and a rename.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SRC = '/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack'

// npm name -> tarball stem (`npm pack` names @bsv/x as bsv-x-<ver>.tgz).
const VENDORED = {
  '@bsv/sdk': 'sdk',
  '@bsv/templates': 'templates',
  '@bsv/wallet-toolbox-client': 'wallet-toolbox-client',
  '@bsv/wallet-toolbox-mobile': 'wallet-toolbox-mobile',
  '@bsv/color-permission-module': 'color-permission-module',
  '@bsv/mandala': 'mandala'
}

// Target peer ranges on the publishable toolbox package (plan 07 W9).
const TOOLBOX_PEERS = {
  '@bsv/sdk': '^4.0.0',
  '@bsv/templates': '^2.2.0',
  '@bsv/wallet-toolbox-mobile': '^2.15.0',
  '@bsv/mandala': '^0.5.0',
  '@bsv/color-permission-module': '^0.2.0'
}

function parseArgs(argv) {
  const out = { src: DEFAULT_SRC, allowMissing: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--src') {
      if (argv[i + 1] === undefined) fail('--src needs a directory')
      out.src = path.resolve(argv[++i])
    } else if (a.startsWith('--src=')) out.src = path.resolve(a.slice('--src='.length))
    else if (a === '--allow-missing') out.allowMissing = true
    else fail(`unknown argument: ${a}`)
  }
  return out
}

function fail(msg) {
  console.error(`vendor-1color: ${msg}`)
  process.exit(1)
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Anchored per package, so `wallet-toolbox` never matches `-client`/`-mobile`.
const packedRe = stem => new RegExp(`^bsv-${escapeRe(stem)}-(\\d+)\\.(\\d+)\\.(\\d+)-([0-9a-f]{7})\\.tgz$`)
// Also catches the pre-1Color sha-less names (vendor/bsv-mandala-0.4.1.tgz).
const anyVendoredRe = stem => new RegExp(`^bsv-${escapeRe(stem)}-\\d+\\.\\d+\\.\\d+(-[0-9a-f]{7})?\\.tgz$`)

function pickNewest(srcDir, stem) {
  const re = packedRe(stem)
  const candidates = fs
    .readdirSync(srcDir)
    .map(f => ({ f, m: re.exec(f) }))
    .filter(c => c.m)
    .map(c => ({
      file: c.f,
      mtime: fs.statSync(path.join(srcDir, c.f)).mtimeMs,
      ver: [Number(c.m[1]), Number(c.m[2]), Number(c.m[3])]
    }))
  if (candidates.length === 0) return undefined
  candidates.sort(
    (a, b) =>
      b.mtime - a.mtime ||
      b.ver[0] - a.ver[0] ||
      b.ver[1] - a.ver[1] ||
      b.ver[2] - a.ver[2] ||
      (a.file < b.file ? 1 : a.file > b.file ? -1 : 0)
  )
  return candidates[0].file
}

function sameBytes(a, b) {
  if (!fs.existsSync(b)) return false
  if (fs.statSync(a).size !== fs.statSync(b).size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

function copyAtomic(from, to) {
  const tmp = `${to}.tmp-${process.pid}`
  fs.copyFileSync(from, tmp)
  fs.renameSync(tmp, to)
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

const sortKeys = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

function main() {
  const { src, allowMissing } = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) fail(`source directory not found: ${src}`)

  // Resolve every name before touching anything, so a strict run with a gap
  // leaves the tree unchanged.
  const chosen = {}
  const missing = []
  for (const [name, stem] of Object.entries(VENDORED)) {
    const file = pickNewest(src, stem)
    if (file) chosen[name] = file
    else missing.push(name)
  }
  for (const name of missing) console.error(`vendor-1color: no bsv-${VENDORED[name]}-<ver>-<sha>.tgz for ${name} in ${src}`)
  if (missing.length > 0 && !allowMissing) fail(`missing ${missing.length} tarball(s); nothing changed`)

  const vendorDir = path.join(ROOT, 'vendor')
  fs.mkdirSync(vendorDir, { recursive: true })

  const rootPkgPath = path.join(ROOT, 'package.json')
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
  rootPkg.dependencies = rootPkg.dependencies ?? {}
  rootPkg.overrides = rootPkg.overrides ?? {}

  for (const [name, file] of Object.entries(chosen)) {
    const stem = VENDORED[name]
    const dest = path.join(vendorDir, file)
    if (!sameBytes(path.join(src, file), dest)) copyAtomic(path.join(src, file), dest)
    for (const old of fs.readdirSync(vendorDir)) {
      if (old !== file && anyVendoredRe(stem).test(old)) {
        fs.unlinkSync(path.join(vendorDir, old))
        console.log(`  removed vendor/${old}`)
      }
    }
    rootPkg.dependencies[name] = `file:vendor/${file}`
    console.log(`${name.padEnd(30)} vendor/${file}`)
  }
  for (const name of missing) console.log(`${name.padEnd(30)} (missing; left as ${rootPkg.dependencies[name] ?? 'absent'})`)

  // Every vendored name is overridden, so transitive users (message-box-client,
  // btms, ...) resolve to the root copy. An override with `$name` needs `name`
  // as a direct dependency; skip it only for a name that is neither vendored
  // nor already a dependency.
  for (const name of Object.keys(VENDORED)) {
    if (rootPkg.dependencies[name] !== undefined) rootPkg.overrides[name] = `$${name}`
  }
  rootPkg.dependencies = sortKeys(rootPkg.dependencies)
  writeJsonAtomic(rootPkgPath, rootPkg)

  const toolboxPkgPath = path.join(ROOT, 'packages/expo-wallet-toolbox/package.json')
  const toolboxPkg = JSON.parse(fs.readFileSync(toolboxPkgPath, 'utf8'))
  toolboxPkg.peerDependencies = sortKeys({ ...(toolboxPkg.peerDependencies ?? {}), ...TOOLBOX_PEERS })
  writeJsonAtomic(toolboxPkgPath, toolboxPkg)

  // The 0.4.1 patch dies with 0.4.1: delete it only once 0.5.0 is vendored.
  if (chosen['@bsv/mandala']) {
    const patchesDir = path.join(ROOT, 'patches')
    if (fs.existsSync(patchesDir)) {
      for (const p of fs.readdirSync(patchesDir)) {
        if (p.startsWith('@bsv+mandala+')) {
          fs.unlinkSync(path.join(patchesDir, p))
          console.log(`  removed patches/${p}`)
        }
      }
    }
  }

  if (missing.length > 0) console.log(`vendor-1color: done with ${missing.length} missing (--allow-missing); re-run strict when they land`)
  else console.log('vendor-1color: done; now run `npm install`')
}

main()
