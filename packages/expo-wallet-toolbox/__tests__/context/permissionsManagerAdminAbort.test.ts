/**
 * Physical-device report 2026-09-25: "Cancel payment" on a failed Nearby
 * payment (noSend, never taken by the payee) only toasted "The action
 * reference was not issued by this permissions manager".
 *
 * Vendored @bsv/wallet-toolbox-mobile 2.14.0's WalletPermissionsManager
 * accepted an abortAction only for a reference still in its in-memory map,
 * which signAction and every app restart empty — so the wallet could never
 * cancel (or release, via replayPendingAborts) a signed noSend payment.
 * Fixed upstream in 2.14.3 (bsv-blockchain/ts-stack#638): the wallet's own
 * admin originator may abort any of its actions; every other originator
 * keeps the issued-reference check (I3). Kept as a regression test.
 */
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'

const ADMIN_ORIGINATOR = 'admin.example.com'
const FOREIGN_ORIGINATOR = 'paired-app.example.com'

function makeManager() {
  const underlying = { abortAction: jest.fn().mockResolvedValue({ aborted: true } as never) }
  const manager = new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {} as never)
  return { underlying, manager }
}

describe('WalletPermissionsManager.abortAction', () => {
  it('lets the admin originator abort a reference this manager instance never issued (a signed or pre-restart action)', async () => {
    const { underlying, manager } = makeManager()
    await expect(manager.abortAction({ reference: 'cmVmLWZyb20tYW4tZWFybGllci1zZXNzaW9u' } as never, ADMIN_ORIGINATOR)).resolves.toEqual({
      aborted: true
    })
    expect(underlying.abortAction).toHaveBeenCalledWith({ reference: 'cmVmLWZyb20tYW4tZWFybGllci1zZXNzaW9u' }, ADMIN_ORIGINATOR)
  })

  it('still refuses a paired app aborting a reference it was not issued, without reaching the wallet', async () => {
    const { underlying, manager } = makeManager()
    await expect(
      manager.abortAction({ reference: 'cmVmLWZyb20tYW4tZWFybGllci1zZXNzaW9u' } as never, FOREIGN_ORIGINATOR)
    ).rejects.toThrow('The action reference was not issued by this permissions manager.')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  it('still refuses a call with no originator', async () => {
    const { underlying, manager } = makeManager()
    await expect(manager.abortAction({ reference: 'cmVm' } as never)).rejects.toThrow(
      'The action reference was not issued by this permissions manager.'
    )
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })
})
