// Plan 07 Task 4: the ESM-only 1Color packages load under jest-expo, and
// @bsv/wallet-toolbox-client is the same module as @bsv/wallet-toolbox-mobile
// (IC D21: an alias, never a fork).
import * as fs from 'fs'
import * as path from 'path'
import * as color from '@bsv/color-permission-module'
import * as client from '@bsv/wallet-toolbox-client'
import * as mobile from '@bsv/wallet-toolbox-mobile'
import { createMandalaProfile, createMandalaOverlayProvider, MANDALA_PROFILE_ID } from '@bsv/mandala/profile'
import { MESSAGEBOX, formatAmount } from '@bsv/mandala'

const root = path.resolve(__dirname, '..')

// The file a package's ESM entry (or dist/<file>) points at. Read through fs,
// because the color module's `exports` does not expose `./package.json`.
function modDist(name: string, file?: string): string {
  const dir = path.join(root, 'node_modules', name)
  if (file) return path.join(dir, 'dist', file)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const imp = pkg.exports['.'].import
  return path.join(dir, typeof imp === 'string' ? imp : imp.default)
}

it('loads the module with the 0.2.0 (B7) surface', () => {
  expect(typeof color.createColorModule).toBe('function')
  expect(typeof color.ColorPermissionModule.prototype.markSettled).toBe('function')
  // B7: no attested profile, no history transport in the module.
  expect((color as Record<string, unknown>).createAttestedProfile).toBeUndefined()
  expect((color as Record<string, unknown>).ATTESTED_PROFILE_ID).toBeUndefined()
  expect(color.COLOR_OFFLINE_TAG).toBe('color_offline')
})

it('aliases toolbox-client to toolbox-mobile (D21)', () => {
  expect(client.WalletPermissionsManager).toBe(mobile.WalletPermissionsManager)
  expect(typeof (mobile as any).encryptMetadata).toBe('function')
  expect(typeof (mobile as any).maybeDecryptMetadata).toBe('function')
  expect(typeof (mobile as any).sdk.specOpBasketPrefixOutputs).toBe('string')
})

it('loads the lib core and profile entries', () => {
  expect(MESSAGEBOX).toBe('mandala-color')
  expect(MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
  expect(formatAmount(18446744073709551615n, 2)).toBe('184467440737095516.15')
  expect(typeof createMandalaProfile).toBe('function')
  expect(typeof createMandalaOverlayProvider).toBe('function')
})

it('ships no Node-only imports on the module path', () => {
  for (const f of [
    modDist('@bsv/color-permission-module'),
    modDist('@bsv/mandala', 'profile.js'),
    modDist('@bsv/mandala', 'index.js')
  ])
    expect(fs.readFileSync(f, 'utf8')).not.toMatch(
      /from ['"](node:|fs['"]|path['"]|crypto['"])|require\(['"](node:|fs['"]|crypto['"])/
    )
})
