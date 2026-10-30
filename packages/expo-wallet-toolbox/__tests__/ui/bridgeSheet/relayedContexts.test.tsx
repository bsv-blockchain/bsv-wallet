jest.mock('expo-secure-store', () => require('../../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../../__mocks__/localAuthFake').fake)

import fs from 'fs'
import path from 'path'
import { RELAYED_CONTEXTS } from '../../../ui/bridgeSheet/relayedContexts'

const TB = path.resolve(__dirname, '../../..')
const ENTRY = path.join(TB, 'ui/components/ui/PermissionSheet.tsx')

/** Hooks that read a relayable context, mapped to the RELAYED_CONTEXTS name they read. */
const HOOK_TO_CONTEXT: Record<string, string> = {
  useTheme: 'ThemeContext',
  useThemeStyles: 'ThemeContext',
  useWallet: 'WalletContext',
  useWalletStatus: 'WalletContext',
  useWalletQueues: 'WalletContext',
  useTxStatusVersion: 'WalletContext',
  useExchangeRate: 'ExchangeRateContext',
  useUser: 'UserContext'
}

/**
 * Contexts that sit in the closure but are intentionally not relayed. LanguageContext is only read by the
 * `useLanguage` hook inside `translations.tsx`, which the sheet does not call: it uses `useTranslation`, which reads the
 * i18n module singleton without a provider (contextRelay.test.tsx proves the Spanish copy under the subscriber alone).
 */
const INTENTIONALLY_NOT_RELAYED = new Set(['LanguageContext'])

function resolveRelative(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec)
  for (const cand of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return undefined
}

function closure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:from|require\()\s*['"](\.[^'"]*)['"]/g)) {
      const next = resolveRelative(file, m[1])
      // Only the sheet's own UI and the core modules it reads; the scan stays inside TB/ui and TB/core.
      if (next && (next.startsWith(path.join(TB, 'ui')) || next.startsWith(path.join(TB, 'core')))) queue.push(next)
    }
  }
  return [...seen]
}

/** Context names read by `useContext(X)` or by a hook that wraps a context, with the file that reads them. */
function contextReads(file: string): Array<{ name: string; how: string }> {
  const src = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const reads: Array<{ name: string; how: string }> = []
  for (const m of src.matchAll(/useContext\(\s*(\w+)\s*\)/g)) reads.push({ name: m[1], how: m[0] })
  for (const [hook, ctx] of Object.entries(HOOK_TO_CONTEXT)) {
    // A call, not the definition (`export const useTheme = ...` / `function useTheme`).
    const call = new RegExp(`(?<!(?:const|function)\\s)\\b${hook}\\(`, 'g')
    if (call.test(src)) reads.push({ name: ctx, how: `${hook}(` })
  }
  return reads
}

describe('RELAYED_CONTEXTS', () => {
  it('names the four contexts the spec lists, each a real context object', () => {
    expect(RELAYED_CONTEXTS.map(e => e.name)).toEqual([
      'ThemeContext',
      'WalletContext',
      'ExchangeRateContext',
      'UserContext'
    ])
    for (const e of RELAYED_CONTEXTS) {
      expect(e.context.Provider).toBeDefined()
      expect(e.context.Consumer).toBeDefined()
    }
  })

  it('the import closure of PermissionSheet.tsx reads no relayable context outside RELAYED_CONTEXTS', () => {
    const relayed = new Set(RELAYED_CONTEXTS.map(e => e.name))
    const files = closure(ENTRY)
    // The scan must have actually walked into the cards, not just read the entry file.
    expect(files.length).toBeGreaterThan(5)
    expect(files.some(f => f.endsWith('AmountDisplay.tsx'))).toBe(true)
    // The package self-import (`@bsv/expo-wallet-toolbox`) is not a relative path: the files that read the
    // relayed contexts through it are the ones scanned above, and a context read there is named in the file.
    const offenders: string[] = []
    const seenRelayed = new Set<string>()
    for (const file of files) {
      for (const { name, how } of contextReads(file)) {
        if (relayed.has(name)) seenRelayed.add(name)
        else if (!INTENTIONALLY_NOT_RELAYED.has(name))
          offenders.push(`${path.relative(TB, file)}: ${how} reads ${name}`)
      }
    }
    expect(offenders).toEqual([])
    // Theme, wallet and exchange rate are all read inside the closure (sanity of the scanner itself).
    expect([...seenRelayed].sort()).toEqual(
      expect.arrayContaining(['ExchangeRateContext', 'ThemeContext', 'WalletContext'])
    )
  })

  it('the scanner flags a context that is not relayed', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'relay-scan-'))
    const f = path.join(dir, 'x.tsx')
    fs.writeFileSync(f, 'const a = useContext(LanguageContext)\nconst b = useTheme()\n')
    expect(contextReads(f)).toEqual([
      { name: 'LanguageContext', how: 'useContext(LanguageContext)' },
      { name: 'ThemeContext', how: 'useTheme(' }
    ])
    fs.rmSync(dir, { recursive: true })
  })
})
