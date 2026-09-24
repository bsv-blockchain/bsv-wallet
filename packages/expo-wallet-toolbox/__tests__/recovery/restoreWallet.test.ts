/**
 * restoreWallet — one attempt: store secret → drop the other secret kind →
 * build (or rebuild, if a wallet already exists) → read the backup-replay
 * outcome (only when asked to restore) → attest. Never throws.
 */
import { restoreWallet } from '../../core/recovery/restoreWallet'
import type { RestoreWalletDeps } from '../../core/recovery/restoreWallet'
import type { WalletSecret } from '../../core/recovery/secret'

const mnemonicSecret: WalletSecret = { kind: 'mnemonic', mnemonic: 'test phrase words', identityKey: 'id-mnemonic' }
const wifSecret: WalletSecret = { kind: 'wif', wif: 'Kx-wif-value', identityKey: 'id-wif' }

function makeDeps(): { deps: RestoreWalletDeps; order: string[] } {
  const order: string[] = []
  const deps: RestoreWalletDeps = {
    setMnemonic: jest.fn(async () => {
      order.push('setMnemonic')
      return true
    }),
    setRecoveredKey: jest.fn(async () => {
      order.push('setRecoveredKey')
      return true
    }),
    deleteMnemonic: jest.fn(async () => {
      order.push('deleteMnemonic')
    }),
    deleteRecoveredKey: jest.fn(async () => {
      order.push('deleteRecoveredKey')
    }),
    buildWalletFromMnemonic: jest.fn(async () => {
      order.push('buildWalletFromMnemonic')
    }),
    buildWalletFromRecoveredKey: jest.fn(async () => {
      order.push('buildWalletFromRecoveredKey')
    }),
    rebuildWallet: jest.fn(async () => {
      order.push('rebuildWallet')
    }),
    isWalletBuilt: jest.fn(() => {
      order.push('isWalletBuilt')
      return false
    }),
    // Not pushed to `order`: restoreWallet.ts never reads this itself — the
    // replace-wallet confirmation guard that reads it lives one layer up, in
    // recoverWallet.ts, BEFORE the first restoreWallet call.
    hasStoredIdentity: jest.fn(async () => false),
    getBackupRestore: jest.fn(() => {
      order.push('getBackupRestore')
      return { phase: 'restored' as const }
    }),
    attest: jest.fn(async () => {
      order.push('attest')
    })
  }
  return { deps, order }
}

describe('restoreWallet', () => {
  test('mnemonic secret: order is setMnemonic → deleteRecoveredKey → buildWalletFromMnemonic → attest; deleteMnemonic never called', async () => {
    const { deps, order } = makeDeps()
    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(order).toEqual([
      'setMnemonic',
      'deleteRecoveredKey',
      'isWalletBuilt',
      'buildWalletFromMnemonic',
      'getBackupRestore',
      'attest'
    ])
    expect(deps.buildWalletFromMnemonic).toHaveBeenCalledWith(
      mnemonicSecret.kind === 'mnemonic' ? mnemonicSecret.mnemonic : '',
      {
        restoreFromBackup: true
      }
    )
    expect(deps.attest).toHaveBeenCalledWith('id-mnemonic', 'phrase')
    expect(deps.deleteMnemonic).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      kind: 'ok',
      identityKey: 'id-mnemonic',
      secret: mnemonicSecret,
      history: 'restored',
      attested: true
    })
  })

  test('wif secret: order is setRecoveredKey → deleteMnemonic → buildWalletFromRecoveredKey → attest; deleteRecoveredKey never called', async () => {
    const { deps, order } = makeDeps()
    const outcome = await restoreWallet(deps, wifSecret, { restore: true, medium: 'shares' })

    expect(order).toEqual([
      'setRecoveredKey',
      'deleteMnemonic',
      'isWalletBuilt',
      'buildWalletFromRecoveredKey',
      'getBackupRestore',
      'attest'
    ])
    expect(deps.buildWalletFromRecoveredKey).toHaveBeenCalledWith('Kx-wif-value', { restoreFromBackup: true })
    expect(deps.attest).toHaveBeenCalledWith('id-wif', 'shares')
    expect(deps.deleteRecoveredKey).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('ok')
  })

  test('setMnemonic → false: biometric-refused, nothing else called', async () => {
    const { deps } = makeDeps()
    ;(deps.setMnemonic as jest.Mock).mockResolvedValueOnce(false)

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(outcome).toEqual({ kind: 'biometric-refused', secret: mnemonicSecret })
    expect(deps.deleteMnemonic).not.toHaveBeenCalled()
    expect(deps.deleteRecoveredKey).not.toHaveBeenCalled()
    expect(deps.buildWalletFromMnemonic).not.toHaveBeenCalled()
    expect(deps.rebuildWallet).not.toHaveBeenCalled()
    expect(deps.attest).not.toHaveBeenCalled()
  })

  test('setRecoveredKey → false: biometric-refused, nothing else called', async () => {
    const { deps } = makeDeps()
    ;(deps.setRecoveredKey as jest.Mock).mockResolvedValueOnce(false)

    const outcome = await restoreWallet(deps, wifSecret, { restore: true, medium: 'shares' })

    expect(outcome).toEqual({ kind: 'biometric-refused', secret: wifSecret })
    expect(deps.deleteMnemonic).not.toHaveBeenCalled()
    expect(deps.deleteRecoveredKey).not.toHaveBeenCalled()
    expect(deps.buildWalletFromRecoveredKey).not.toHaveBeenCalled()
    expect(deps.rebuildWallet).not.toHaveBeenCalled()
    expect(deps.attest).not.toHaveBeenCalled()
  })

  test('isWalletBuilt() → true: rebuildWallet called instead of build fn, for both secret kinds; isWalletBuilt read after the store step', async () => {
    const { deps: mDeps, order: mOrder } = makeDeps()
    ;(mDeps.isWalletBuilt as jest.Mock).mockImplementation(() => {
      mOrder.push('isWalletBuilt')
      return true
    })
    await restoreWallet(mDeps, mnemonicSecret, { restore: true, medium: 'phrase' })
    expect(mDeps.buildWalletFromMnemonic).not.toHaveBeenCalled()
    expect(mDeps.rebuildWallet).toHaveBeenCalledWith({ restoreFromBackup: true })
    expect(mOrder.indexOf('isWalletBuilt')).toBeGreaterThan(mOrder.indexOf('setMnemonic'))

    const { deps: wDeps, order: wOrder } = makeDeps()
    ;(wDeps.isWalletBuilt as jest.Mock).mockImplementation(() => {
      wOrder.push('isWalletBuilt')
      return true
    })
    await restoreWallet(wDeps, wifSecret, { restore: false, medium: 'shares' })
    expect(wDeps.buildWalletFromRecoveredKey).not.toHaveBeenCalled()
    expect(wDeps.rebuildWallet).toHaveBeenCalledWith({ restoreFromBackup: false })
    expect(wOrder.indexOf('isWalletBuilt')).toBeGreaterThan(wOrder.indexOf('setRecoveredKey'))
  })

  test('restore:true and phase failed with error → restore-failed, attest not called', async () => {
    const { deps } = makeDeps()
    ;(deps.getBackupRestore as jest.Mock).mockReturnValue({ phase: 'failed', error: 'boom' })

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(outcome).toEqual({
      kind: 'restore-failed',
      identityKey: 'id-mnemonic',
      secret: mnemonicSecret,
      error: 'boom'
    })
    expect(deps.attest).not.toHaveBeenCalled()
  })

  test('restore:false and phase left over as failed → still ok/skipped; getBackupRestore never called', async () => {
    const { deps } = makeDeps()
    ;(deps.getBackupRestore as jest.Mock).mockReturnValue({ phase: 'failed', error: 'stale' })

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: false, medium: 'phrase' })

    expect(deps.getBackupRestore).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'ok', history: 'skipped' })
  })

  test.each([
    ['restored', 'restored'],
    ['no-backup', 'no-backup'],
    ['idle', 'unknown']
  ] as const)('restore:true, phase %s → history %s', async (phase, history) => {
    const { deps } = makeDeps()
    ;(deps.getBackupRestore as jest.Mock).mockReturnValue({ phase })

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(outcome).toMatchObject({ kind: 'ok', history })
  })

  test('attest throws → still ok/attested:false, console.warn with [recovery] tag', async () => {
    const { deps } = makeDeps()
    ;(deps.attest as jest.Mock).mockRejectedValueOnce(new Error('attest failed'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(outcome).toMatchObject({ kind: 'ok', attested: false })
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('[recovery]'))).toBe(true)
    warnSpy.mockRestore()
  })

  test('attest resolves → attested:true', async () => {
    const { deps } = makeDeps()
    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })
    expect(outcome).toMatchObject({ kind: 'ok', attested: true })
  })

  test('build fn throws → failed with error message', async () => {
    const { deps } = makeDeps()
    ;(deps.buildWalletFromMnemonic as jest.Mock).mockRejectedValueOnce(new Error('build boom'))

    const outcome = await restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })

    expect(outcome).toEqual({ kind: 'failed', secret: mnemonicSecret, error: 'build boom' })
  })

  test('setMnemonic throws → failed, never rejects', async () => {
    const { deps } = makeDeps()
    ;(deps.setMnemonic as jest.Mock).mockRejectedValueOnce(new Error('store boom'))

    await expect(restoreWallet(deps, mnemonicSecret, { restore: true, medium: 'phrase' })).resolves.toMatchObject({
      kind: 'failed'
    })
  })

  test('medium is passed through verbatim to attest', async () => {
    const { deps: d1 } = makeDeps()
    await restoreWallet(d1, mnemonicSecret, { restore: true, medium: 'shares' })
    expect(d1.attest).toHaveBeenCalledWith('id-mnemonic', 'shares')

    const { deps: d2 } = makeDeps()
    await restoreWallet(d2, wifSecret, { restore: true, medium: 'phrase' })
    expect(d2.attest).toHaveBeenCalledWith('id-wif', 'phrase')
  })
})
