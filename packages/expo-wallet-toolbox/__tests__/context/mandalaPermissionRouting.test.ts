/**
 * A regression here would silently reopen the exact gap
 * offline-settlement-final.md §8.1 closes: `'mandala-tokens'` was a plain
 * basket with every seekBasket*Permission flag off, so a paired app could
 * list/spend/credit/relinquish Mandala token outputs with no prompt at all.
 * §8.3's fix is renaming the basket to `MANDALA_BASKET` ('p mandala') so
 * `WalletPermissionsManager`'s P-routing (any basket starting with `'p '`,
 * regardless of originator) picks it up. This test proves the actual,
 * un-mocked `WalletPermissionsManager` really does route a `listOutputs`
 * call against that basket name to `MandalaTokenModule.onRequest`.
 */
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { MandalaTokenModule } from '../../core/mandala/permissionModule'
import { MANDALA_BASKET } from '../../core/mandala/types'

const ADMIN_ORIGINATOR = 'admin.example.com'
const FOREIGN_ORIGINATOR = 'paired-app.example.com'

/** The minimal underlying BRC-100 wallet WalletPermissionsManager forwards to. */
function makeUnderlyingWallet() {
  return {
    listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 0, outputs: [] } as never)
  }
}

function makePermissionsManager(
  underlying: ReturnType<typeof makeUnderlyingWallet>,
  mandalaModule: MandalaTokenModule
) {
  return new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {
    permissionModules: { mandala: mandalaModule }
  } as never)
}

describe('WalletPermissionsManager P-routing for MANDALA_BASKET', () => {
  it('routes listOutputs({basket: MANDALA_BASKET}) from a non-admin originator into MandalaTokenModule.onRequest', async () => {
    const requestTokenAccess = jest.fn().mockResolvedValue(true)
    const mandalaModule = new MandalaTokenModule({
      adminOriginator: ADMIN_ORIGINATOR,
      requestTokenAccess,
      resolveAssetMetadata: async () => null,
      listTokenOutpoints: async () => new Set(),
      resolveMandalaOutput: jest.fn().mockResolvedValue(null)
    })
    const onRequestSpy = jest.spyOn(mandalaModule, 'onRequest')
    const underlying = makeUnderlyingWallet()
    const permissionsManager = makePermissionsManager(underlying, mandalaModule)

    const result = await permissionsManager.listOutputs({ basket: MANDALA_BASKET } as never, FOREIGN_ORIGINATOR)

    expect(onRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'listOutputs', originator: FOREIGN_ORIGINATOR })
    )
    // The module's own access prompt fired -- proof the request reached the
    // module's logic, not just its onRequest entry point.
    expect(requestTokenAccess).toHaveBeenCalledTimes(1)
    // And the call reaches the underlying wallet unchanged once the module
    // approves.
    expect(underlying.listOutputs).toHaveBeenCalledWith({ basket: MANDALA_BASKET }, FOREIGN_ORIGINATOR)
    expect(result).toEqual({ totalOutputs: 0, outputs: [] })
  })

  it('a paired app that asks for includeCustomInstructions gets them back (the Mandala lib needs them to issue and send)', async () => {
    const requestTokenAccess = jest.fn().mockResolvedValue(true)
    const mandalaModule = new MandalaTokenModule({
      adminOriginator: ADMIN_ORIGINATOR,
      requestTokenAccess,
      resolveAssetMetadata: async () => null,
      listTokenOutpoints: async () => new Set(),
      resolveMandalaOutput: jest.fn().mockResolvedValue(null)
    })
    const underlying = {
      // Simulates a real wallet: it includes customInstructions only when
      // asked.
      listOutputs: jest.fn().mockImplementation(async (args: { includeCustomInstructions?: boolean }) => ({
        totalOutputs: 1,
        outputs: [
          {
            outpoint: `${'a'.repeat(64)}.0`,
            satoshis: 1,
            spendable: true,
            ...(args.includeCustomInstructions ? { customInstructions: 'keyID:1|counterparty:02deadbeef' } : {})
          }
        ]
      }))
    }
    const permissionsManager = makePermissionsManager(underlying as never, mandalaModule)

    const result = await permissionsManager.listOutputs(
      { basket: MANDALA_BASKET, includeCustomInstructions: true } as never,
      FOREIGN_ORIGINATOR
    )

    expect(underlying.listOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ includeCustomInstructions: true }),
      FOREIGN_ORIGINATOR
    )
    expect((result as { outputs: Array<{ customInstructions?: string }> }).outputs[0].customInstructions).toBe(
      'keyID:1|counterparty:02deadbeef'
    )
  })

  it('throws instead of silently denying when no mandala module is registered (the pre-fix gap, guarded)', async () => {
    const underlying = makeUnderlyingWallet()
    const permissionsManager = new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {} as never)

    await expect(
      permissionsManager.listOutputs({ basket: MANDALA_BASKET } as never, FOREIGN_ORIGINATOR)
    ).rejects.toThrow('Unsupported P-module scheme: p mandala')
    expect(underlying.listOutputs).not.toHaveBeenCalled()
  })

  it('the admin originator reaches the underlying wallet directly, with zero module prompts', async () => {
    const requestTokenAccess = jest.fn().mockResolvedValue(true)
    const mandalaModule = new MandalaTokenModule({
      adminOriginator: ADMIN_ORIGINATOR,
      requestTokenAccess,
      resolveAssetMetadata: async () => null,
      listTokenOutpoints: async () => new Set(),
      resolveMandalaOutput: jest.fn().mockResolvedValue(null)
    })
    const underlying = makeUnderlyingWallet()
    const permissionsManager = makePermissionsManager(underlying, mandalaModule)

    await permissionsManager.listOutputs({ basket: MANDALA_BASKET } as never, ADMIN_ORIGINATOR)

    expect(requestTokenAccess).not.toHaveBeenCalled()
    // Admin is NOT redacted -- args pass through exactly as asked, per the
    // module's admin pass-through branch.
    expect(underlying.listOutputs).toHaveBeenCalledWith({ basket: MANDALA_BASKET }, ADMIN_ORIGINATOR)
  })

  it('a denied listOutputs prompt refuses the call before it ever reaches the underlying wallet', async () => {
    const requestTokenAccess = jest.fn().mockResolvedValue(false)
    const mandalaModule = new MandalaTokenModule({
      adminOriginator: ADMIN_ORIGINATOR,
      requestTokenAccess,
      resolveAssetMetadata: async () => null,
      listTokenOutpoints: async () => new Set(),
      resolveMandalaOutput: jest.fn().mockResolvedValue(null)
    })
    const underlying = makeUnderlyingWallet()
    const permissionsManager = makePermissionsManager(underlying, mandalaModule)

    await expect(
      permissionsManager.listOutputs({ basket: MANDALA_BASKET } as never, FOREIGN_ORIGINATOR)
    ).rejects.toThrow('User denied permission to access Mandala tokens')
    expect(underlying.listOutputs).not.toHaveBeenCalled()
  })
})
