import * as fs from 'fs'
import * as path from 'path'

/**
 * The Safari extension bundles `core/bridge/protocol/*` (spec 6.8 Bundle safety). Nothing those
 * modules import, transitively, may drag the app into the bundle.
 */
const bridgeDir = path.resolve(__dirname, '../../../core/bridge')
const protocolDir = path.join(bridgeDir, 'protocol')

const FORBIDDEN_SPECIFIERS = [
  /^react-native($|\/)/,
  /^expo($|-|\/)/,
  /^@bsv\/wallet-toolbox-mobile($|\/)/,
  /^@react-native-async-storage\//
]
const FORBIDDEN_TEXT = [/__DEV__/, /process\.env/]
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveRelative(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec)
  for (const candidate of [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`Cannot resolve ${spec} from ${from}`)
}

function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // `import type` is erased by the compiler: it adds nothing to a bundle (the loopback router's port types
      // name runtime types this way).
      .replace(/(^|\n)\s*import\s+type\s[^'"]*?from\s*['"][^'"]+['"]/g, '$1')
  )
}

function walk(entry: string): { files: string[]; problems: string[] } {
  const seen = new Set<string>()
  const problems: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const re of FORBIDDEN_TEXT) if (re.test(src)) problems.push(`${path.relative(bridgeDir, file)} uses ${re}`)
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (spec === undefined) continue
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        const rel = path.relative(bridgeDir, resolved)
        if (/(^|\/)config(\.tsx?)?$/.test(rel) || rel.startsWith('..')) {
          problems.push(`${path.relative(bridgeDir, file)} imports ${spec} (${rel})`)
        } else {
          visit(resolved)
        }
      } else if (FORBIDDEN_SPECIFIERS.some(re => re.test(spec))) {
        problems.push(`${path.relative(bridgeDir, file)} imports ${spec}`)
      }
    }
  }
  visit(entry)
  return { files: [...seen], problems }
}

describe('protocol modules are bundle-safe', () => {
  const entries = fs
    .readdirSync(protocolDir)
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(protocolDir, f))

  it('finds the protocol modules', () => {
    expect(entries.length).toBeGreaterThanOrEqual(10)
  })

  it.each(entries.map(e => [path.basename(e), e]))('%s has a pure import graph', (_name, entry) => {
    const { problems } = walk(entry as string)
    expect(problems).toEqual([])
  })

  it('loopback modules have a pure import graph', () => {
    const dir = path.join(bridgeDir, 'loopback')
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) expect(walk(path.join(dir, f)).problems).toEqual([])
  })

  it('origin.ts reaches the pure constants module, not the app config', () => {
    const { files } = walk(path.join(protocolDir, 'origin.ts'))
    expect(files.map(f => path.relative(bridgeDir, f))).toContain('protocol/constants.ts')
  })

  it('permissionPolicy.ts does not import ../config', () => {
    const src = stripComments(fs.readFileSync(path.join(bridgeDir, 'permissionPolicy.ts'), 'utf8'))
    expect(src).not.toMatch(/from\s*['"]\.\.\/config['"]/)
  })
})
