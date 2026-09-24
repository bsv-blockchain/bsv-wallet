/**
 * recoverWallet — the retry/skip policy wrapped around restoreWallet:
 * a refused biometric offers retry/cancel, a failed restore offers
 * retry/skip. The loop must terminate.
 */
import { recoverWallet } from '../../core/recovery/recoverWallet'
import type { RestoreWalletDeps } from '../../core/recovery/restoreWallet'
import type { RestorePrompts } from '../../core/recovery/recoverWallet'
import type { WalletSecret } from '../../core/recovery/secret'

const mnemonicSecret: WalletSecret = { kind: 'mnemonic', mnemonic: 'test phrase words', identityKey: 'id-mnemonic' }

function makeDeps(overrides: Partial<RestoreWalletDeps> = {}): RestoreWalletDeps {
  return {
    setMnemonic: jest.fn(async () => true),
    setRecoveredKey: jest.fn(async () => true),
    deleteMnemonic: jest.fn(async () => {}),
    deleteRecoveredKey: jest.fn(async () => {}),
    buildWalletFromMnemonic: jest.fn(async () => {}),
    buildWalletFromRecoveredKey: jest.fn(async () => {}),
    rebuildWallet: jest.fn(async () => {}),
    isWalletBuilt: jest.fn(() => false),
    getBackupRestore: jest.fn(() => ({ phase: 'restored' as const })),
    attest: jest.fn(async () => {}),
    ...overrides
  }
}

function makePrompts(overrides: Partial<RestorePrompts> = {}): RestorePrompts {
  return {
    biometricRefused: jest.fn(async () => 'cancel' as const),
    restoreFailed: jest.fn(async () => 'skip' as const),
    ...overrides
  }
}

describe('recoverWallet', () => {
  test('happy path: one restoreWallet attempt, prompts never called, outcome ok', async () => {
    const deps = makeDeps()
    const prompts = makePrompts()

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(deps.setMnemonic).toHaveBeenCalledTimes(1)
    expect(prompts.biometricRefused).not.toHaveBeenCalled()
    expect(prompts.restoreFailed).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'ok', history: 'restored', attested: true })
  })

  test('refused → biometricRefused resolves retry → second attempt succeeds → ok; biometricRefused called once', async () => {
    const setMnemonic = jest
      .fn(async () => false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const deps = makeDeps({ setMnemonic })
    const prompts = makePrompts({ biometricRefused: jest.fn(async () => 'retry' as const) })

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(setMnemonic).toHaveBeenCalledTimes(2)
    expect(prompts.biometricRefused).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('ok')
  })

  test('refused → cancel → cancelled; exactly one store attempt, no build', async () => {
    const deps = makeDeps({ setMnemonic: jest.fn(async () => false) })
    const prompts = makePrompts({ biometricRefused: jest.fn(async () => 'cancel' as const) })

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(deps.setMnemonic).toHaveBeenCalledTimes(1)
    expect(deps.buildWalletFromMnemonic).not.toHaveBeenCalled()
  })

  test('restore failed → restoreFailed("boom") → skip → second attempt restore:false succeeds, secret stored twice, attest once', async () => {
    let calls = 0
    const getBackupRestore = jest.fn(() => {
      calls += 1
      return calls === 1 ? { phase: 'failed' as const, error: 'boom' } : { phase: 'restored' as const }
    })
    const deps = makeDeps({ getBackupRestore })
    const prompts = makePrompts({ restoreFailed: jest.fn(async () => 'skip' as const) })

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(prompts.restoreFailed).toHaveBeenCalledWith('boom')
    expect(deps.setMnemonic).toHaveBeenCalledTimes(2)
    expect(deps.buildWalletFromMnemonic).toHaveBeenNthCalledWith(2, mnemonicSecret.mnemonic, {
      restoreFromBackup: false
    })
    expect(deps.attest).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'ok', history: 'skipped' })
  })

  test('restore failed → retry → retry-later; no further deps calls after the prompt', async () => {
    const getBackupRestore = jest.fn(() => ({ phase: 'failed' as const, error: 'boom' }))
    const deps = makeDeps({ getBackupRestore })
    const prompts = makePrompts({ restoreFailed: jest.fn(async () => 'retry' as const) })

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(outcome).toEqual({ kind: 'retry-later' })
    expect(deps.setMnemonic).toHaveBeenCalledTimes(1)
    expect(deps.attest).not.toHaveBeenCalled()
  })

  test('restoreWallet failed → failed passthrough, prompts never called', async () => {
    const deps = makeDeps({
      buildWalletFromMnemonic: jest.fn(async () => {
        throw new Error('build boom')
      })
    })
    const prompts = makePrompts()

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(outcome).toEqual({ kind: 'failed', error: 'build boom' })
    expect(prompts.biometricRefused).not.toHaveBeenCalled()
    expect(prompts.restoreFailed).not.toHaveBeenCalled()
  })

  test('a refusal during the skip re-store (second attempt returns false) → biometricRefused again → cancel → cancelled', async () => {
    const setMnemonic = jest
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const getBackupRestore = jest.fn(() => ({ phase: 'failed' as const, error: 'boom' }))
    const deps = makeDeps({ setMnemonic, getBackupRestore })
    const prompts = makePrompts({
      restoreFailed: jest.fn(async () => 'skip' as const),
      biometricRefused: jest.fn(async () => 'cancel' as const)
    })

    const outcome = await recoverWallet(deps, mnemonicSecret, { medium: 'phrase', prompts })

    expect(setMnemonic).toHaveBeenCalledTimes(2)
    expect(prompts.restoreFailed).toHaveBeenCalledTimes(1)
    expect(prompts.biometricRefused).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'cancelled' })
  })
})
