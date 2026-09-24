/**
 * createNewWallet — the "generate a brand new wallet" path (mnemonic.tsx's
 * handleGenerateNew). Guards against creating over an existing identity,
 * marks the backup as pending, and builds without a restore option (nothing
 * to restore for a freshly generated wallet).
 */
import { createNewWallet } from '../../core/recovery/createWallet'
import type { CreateWalletDeps } from '../../core/recovery/createWallet'

const generated = { mnemonic: 'brand new phrase words', identityKey: 'id-new' }

function makeDeps(overrides: Partial<CreateWalletDeps> = {}): CreateWalletDeps {
  return {
    generate: jest.fn(() => generated),
    hasStoredIdentity: jest.fn(async () => false),
    createMnemonic: jest.fn(async () => true),
    markPending: jest.fn(async () => {}),
    buildWalletFromMnemonic: jest.fn(async () => {}),
    isWalletBuilt: jest.fn(() => false),
    ...overrides
  }
}

describe('createNewWallet', () => {
  test('isWalletBuilt() true → exists, generate not called', async () => {
    const deps = makeDeps({ isWalletBuilt: jest.fn(() => true) })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'exists' })
    expect(deps.generate).not.toHaveBeenCalled()
  })

  test('hasStoredIdentity true → exists', async () => {
    const deps = makeDeps({ hasStoredIdentity: jest.fn(async () => true) })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'exists' })
    expect(deps.generate).not.toHaveBeenCalled()
  })

  test('createMnemonic false + hasStoredIdentity now true → exists', async () => {
    const hasStoredIdentity = jest
      .fn(async () => false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const deps = makeDeps({ createMnemonic: jest.fn(async () => false), hasStoredIdentity })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'exists' })
    expect(deps.buildWalletFromMnemonic).not.toHaveBeenCalled()
  })

  test('createMnemonic false + still no identity → refused, build not called', async () => {
    const deps = makeDeps({ createMnemonic: jest.fn(async () => false) })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'refused' })
    expect(deps.buildWalletFromMnemonic).not.toHaveBeenCalled()
  })

  test('success: order generate → createMnemonic → onStored → markPending → buildWalletFromMnemonic (no opts) → created', async () => {
    const order: string[] = []
    const deps = makeDeps({
      generate: jest.fn(() => {
        order.push('generate')
        return generated
      }),
      createMnemonic: jest.fn(async () => {
        order.push('createMnemonic')
        return true
      }),
      markPending: jest.fn(async () => {
        order.push('markPending')
      }),
      buildWalletFromMnemonic: jest.fn(async () => {
        order.push('buildWalletFromMnemonic')
      })
    })
    const onStored = jest.fn((w: { mnemonic: string; identityKey: string }) => {
      order.push('onStored')
      expect(w).toEqual(generated)
    })

    const outcome = await createNewWallet(deps, { onStored })

    expect(order).toEqual(['generate', 'createMnemonic', 'onStored', 'markPending', 'buildWalletFromMnemonic'])
    expect(deps.buildWalletFromMnemonic).toHaveBeenCalledWith(generated.mnemonic)
    expect(outcome).toEqual({ kind: 'created', mnemonic: generated.mnemonic, identityKey: generated.identityKey })
  })

  test('markPending throws → still created, console.warn called', async () => {
    const deps = makeDeps({
      markPending: jest.fn(async () => {
        throw new Error('pending boom')
      })
    })
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await createNewWallet(deps)

    expect(outcome).toEqual({ kind: 'created', mnemonic: generated.mnemonic, identityKey: generated.identityKey })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test('buildWalletFromMnemonic throws → failed', async () => {
    const deps = makeDeps({
      buildWalletFromMnemonic: jest.fn(async () => {
        throw new Error('build boom')
      })
    })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'failed', error: 'build boom' })
  })

  test('generate throws → failed', async () => {
    const deps = makeDeps({
      generate: jest.fn(() => {
        throw new Error('generate boom')
      })
    })
    const outcome = await createNewWallet(deps)
    expect(outcome).toEqual({ kind: 'failed', error: 'generate boom' })
  })
})
