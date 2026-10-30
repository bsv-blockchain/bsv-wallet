// Plan 07 Task 2: the still-unpublished 1Color package (@bsv/mandala) is a
// vendored tarball (IC §9); @bsv/sdk 4.0.x, @bsv/wallet-toolbox-mobile 2.15.x,
// @bsv/templates 2.2.x and @bsv/color-permission-module 0.2.x come from the
// registry. Every package.json is read through fs, because the color module's
// `exports` does not expose `./package.json`.
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '..')
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
const rootPkg = readJson(path.join(root, 'package.json'))
const toolboxPkg = readJson(path.join(root, 'packages/expo-wallet-toolbox/package.json'))

const VENDORED: Record<string, string> = {
  '@bsv/mandala': '0.5.0'
}

/** Published: registry ranges, still overridden to one root copy. */
const PUBLISHED: Record<string, { spec: string; version: RegExp }> = {
  '@bsv/sdk': { spec: '^4.0.0', version: /^4\./ },
  '@bsv/templates': { spec: '^2.2.0', version: /^2\.2\./ },
  '@bsv/color-permission-module': { spec: '^0.2.0', version: /^0\.2\./ },
  '@bsv/wallet-toolbox-mobile': { spec: '^2.15.0', version: /^2\.(1[5-9]|[2-9]\d)\./ },
  // The color module's peer, satisfied by -mobile itself (IC D21): no second toolbox.
  '@bsv/wallet-toolbox-client': { spec: 'npm:@bsv/wallet-toolbox-mobile@^2.15.0', version: /^2\.(1[5-9]|[2-9]\d)\./ }
}

const installedVersionAt = (pkgJsonPath: string): string | undefined =>
  fs.existsSync(pkgJsonPath) ? readJson(pkgJsonPath).version : undefined

const installedVersion = (name: string) =>
  installedVersionAt(path.join(root, 'node_modules', name, 'package.json'))

// Every nested copy of `name`: node_modules/**/node_modules/<name>/package.json,
// skipping .bin, at most 6 node_modules levels deep. The top-level copy is not
// included.
function nestedCopies(name: string): string[] {
  const found: string[] = []
  const walk = (nodeModules: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(nodeModules)) return
    for (const entry of fs.readdirSync(nodeModules)) {
      if (entry === '.bin' || entry.startsWith('.')) continue
      const pkgDirs = entry.startsWith('@')
        ? fs.readdirSync(path.join(nodeModules, entry)).map(s => path.join(nodeModules, entry, s))
        : [path.join(nodeModules, entry)]
      for (const dir of pkgDirs) {
        let stat: fs.Stats
        try {
          stat = fs.lstatSync(dir)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue // symlinked workspace packages are walked at their source
        const inner = path.join(dir, 'node_modules')
        const candidate = path.join(inner, name, 'package.json')
        if (fs.existsSync(candidate)) found.push(candidate)
        walk(inner, depth + 1)
      }
    }
  }
  walk(path.join(root, 'node_modules'), 1)
  return found
}

describe('1Color vendored packages', () => {
  it('pins every vendored package to a file: tarball that exists', () => {
    for (const name of Object.keys(VENDORED)) {
      const spec = rootPkg.dependencies[name]
      expect(spec).toMatch(/^file:vendor\/bsv-[a-z-]+-\d+\.\d+\.\d+-[0-9a-f]{7}\.tgz$/)
      expect(fs.existsSync(path.join(root, spec.slice(5)))).toBe(true)
      expect(rootPkg.overrides[name]).toBe(`$${name}`)
    }
  })

  it('installs exactly the vendored versions', () => {
    for (const [name, v] of Object.entries(VENDORED)) expect([name, installedVersion(name)]).toEqual([name, v])
  })

  it('takes the published packages from the registry, with no tarball left', () => {
    for (const [name, { spec, version }] of Object.entries(PUBLISHED)) {
      expect([name, rootPkg.dependencies[name]]).toEqual([name, spec])
      expect(rootPkg.overrides[name]).toBe(`$${name}`)
      expect(installedVersion(name)).toMatch(version)
    }
    const left = fs.readdirSync(path.join(root, 'vendor')).filter(f => /^bsv-(sdk|templates|color-permission-module|wallet-toolbox(-client|-mobile)?)-/.test(f))
    expect(left).toEqual([])
    const clientPkg = readJson(path.join(root, 'node_modules/@bsv/wallet-toolbox-client/package.json'))
    expect(clientPkg.name).toBe('@bsv/wallet-toolbox-mobile')
  })

  it('has one @bsv/sdk in the tree', () => {
    const top = installedVersion('@bsv/sdk')
    expect(nestedCopies('@bsv/sdk').filter(p => installedVersionAt(p) !== top)).toEqual([])
  })

  it('drops the old Mandala tarball and patch', () => {
    expect(fs.existsSync(path.join(root, 'vendor/bsv-mandala-0.4.1.tgz'))).toBe(false)
    expect(fs.readdirSync(path.join(root, 'patches')).filter(f => f.startsWith('@bsv+mandala+'))).toEqual([])
  })

  it('declares 1Color peer ranges on the toolbox package', () => {
    expect(toolboxPkg.peerDependencies).toMatchObject({
      '@bsv/sdk': '^4.0.0',
      '@bsv/templates': '^2.2.0',
      '@bsv/wallet-toolbox-mobile': '^2.15.0',
      '@bsv/mandala': '^0.5.0',
      '@bsv/color-permission-module': '^0.2.0'
    })
  })
})
