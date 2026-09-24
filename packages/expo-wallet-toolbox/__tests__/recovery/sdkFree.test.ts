/**
 * Guard: the orchestration modules (restoreWallet, recoverWallet,
 * createWallet, shareCollector) must never load `@bsv/sdk` at runtime — only
 * `secret.ts`, `shares.ts` and `backupMaterial.ts` may. This is what lets a
 * screen test mock `@bsv/sdk` with a closed object literal
 * (`__tests__/mnemonicSafety.test.tsx`) while still wiring in the REAL
 * orchestration logic via `jest.requireActual`.
 *
 * Because babel elides type-only imports, `import type` alone would already
 * make this pass trivially — this test is the real guard: it proves no
 * VALUE import anywhere in each module's dependency graph reaches `@bsv/sdk`.
 */
jest.mock('@bsv/sdk', () => {
  throw new Error('@bsv/sdk must not be loaded by orchestration modules')
})

describe('recovery orchestration modules are sdk-free', () => {
  test('restoreWallet loads without @bsv/sdk', () => {
    const mod = require('../../core/recovery/restoreWallet')
    expect(typeof mod.restoreWallet).toBe('function')
  })

  test('recoverWallet loads without @bsv/sdk', () => {
    const mod = require('../../core/recovery/recoverWallet')
    expect(typeof mod.recoverWallet).toBe('function')
  })

  test('createWallet loads without @bsv/sdk', () => {
    const mod = require('../../core/recovery/createWallet')
    expect(typeof mod.createNewWallet).toBe('function')
  })

  test('shareCollector loads without @bsv/sdk', () => {
    const mod = require('../../core/recovery/shareCollector')
    expect(typeof mod.collectShare).toBe('function')
  })
})
