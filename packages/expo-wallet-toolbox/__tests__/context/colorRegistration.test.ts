/**
 * The wallet registers the BRC-207 color module, and nothing of the deleted
 * `'p mandala'` P-module, in the permissions manager it publishes (plan 07
 * Task 10).
 *
 * Structural, in the same style as `mandalaDrainTick.test.ts`: rendering the
 * whole provider to reach `buildWallet` is too heavy to keep. One behavioural
 * test sits beside it: the wrapper stack WalletContext publishes must carry a
 * `signAction` result's `colorHandoff` through untouched, because the runtime
 * reads hand-over evidence off it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { conformWalletResults } from '../../core/services/conformWalletResults'
import { guardVaultAccess } from '../../core/services/vault/guard'
import { wrapAbortActionForSettlements } from '../../core/mandala/abortGuard'

const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')

/** Comments stripped: they may name these calls, and a comment wires nothing. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .join('\n')

/** The object literal handed to the permissions manager as `permissionModules`. */
const permissionModules = (() => {
  const start = code.indexOf('permissionModules')
  if (start < 0) throw new Error('permissionModules has moved or been renamed')
  return code.slice(start, code.indexOf('\n', start) + 1)
})()

describe('color module registration in WalletContext', () => {
  it('registers the color module under the color scheme', () => {
    expect(permissionModules).toContain('color: ')
  })

  it('carries nothing of the deleted p mandala P-module', () => {
    // Comments included: a doc that still names the deleted module misleads the next reader.
    const banned = [
      'MandalaTokenModule',
      'wrapCreateActionForTokenInputs',
      'migrateMandalaBasketName',
      'mandala/permissionModule',
      'mandala/basketMigration',
      'MANDALA_BASKET'
    ]
    expect(banned.filter(name => source.includes(name))).toEqual([])
  })

  it('builds the module over the underlying wallet, never the permissions manager', () => {
    const start = code.indexOf('buildColorModule({')
    expect(start).toBeGreaterThan(-1)
    const call = code.slice(start, code.indexOf('})', start))
    expect(call).toMatch(/\bwallet,/)
    expect(call).not.toContain('permissionsManager')
  })

  it('answers the module’s consent through the color access policy', () => {
    expect(code).toContain('createColorAccessPolicy({')
  })

  it('points the abort refusal at the transfer journal', () => {
    expect(code).toContain('() => mandalaRef.current?.journal')
    expect(code).not.toContain('() => mandalaRef.current?.store')
  })

  it('replaces the color module only while the build is still the wanted one', () => {
    // A build a network switch overtook must not dispose the next build's live module.
    const build = code.indexOf('buildColorModule({')
    const guard = code.lastIndexOf('if (stillWanted()) {', build)
    expect(guard).toBeGreaterThan(-1)
    const guarded = code.slice(guard, build)
    expect(guarded).toContain('disposeColorModule(colorRef)')
    expect(guarded).not.toContain('await ')
  })

  it('disposes the color module wherever the wallet is torn down', () => {
    const teardowns = code.split('setMandala(undefined)').length - 1
    // The build (a leftover module from an earlier build), rebuild/switch teardown, and logout.
    const disposals = code.split('disposeColorModule(colorRef)').length - 1
    expect(teardowns).toBeGreaterThan(0)
    expect(disposals).toBeGreaterThanOrEqual(3)
  })
})

describe('the published manager stack', () => {
  it('carries colorHandoff through the published manager stack', async () => {
    const ADMIN = 'admin.example'
    const txid = 'ab'.repeat(32)
    const colorHandoff = { version: 1, txid, profileData: {} }
    const fake = {
      signAction: jest.fn(async (_args: unknown, _originator?: string) => ({ txid, colorHandoff })),
      abortAction: jest.fn(async (_args: { reference: string }, _originator?: string) => ({ aborted: true }))
    }
    const lookup = {
      anyAdminOutpoint: jest.fn(async () => false),
      anyAdminTransaction: jest.fn(async () => false)
    }
    const pm = guardVaultAccess(
      wrapAbortActionForSettlements(
        conformWalletResults(ADMIN, fake),
        () => undefined,
        () => true
      ) as never,
      ADMIN,
      { lookup }
    ) as unknown as typeof fake
    const result = await pm.signAction({ reference: 'cmVm', spends: {} } as never, 'app.example' as never)
    expect(result).toEqual({ txid, colorHandoff })
    const admin = await pm.signAction({ reference: 'cmVm', spends: {} } as never, ADMIN as never)
    expect((admin as { colorHandoff?: unknown }).colorHandoff).toEqual(colorHandoff)
  })
})
