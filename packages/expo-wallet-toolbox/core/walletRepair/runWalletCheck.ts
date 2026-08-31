/**
 * Ordered Check-my-wallet repair steps.
 *
 * Records first so phantom spendable outputs do not poison later sends.
 * freedCoins = reviewSpendable.released + releaseStuck.released + reviewStatus.restoredInputs
 */

export type WalletCheckStepId = 'coins' | 'proofs' | 'records' | 'missed_payments'

export interface WalletCheckPorts {
  reviewSpendable: () => Promise<{ released: number; recovered: number }>
  checkProofs: () => Promise<{ repaired: number }>
  reviewStatus: () => Promise<{ failedTxs: number; restoredInputs: number }>
  releaseStuck: () => Promise<{ released: number }>
  creditInbox: () => Promise<{ accepted: number }>
  sweepAddresses: () => Promise<{ imported: number }>
}

export async function runWalletCheck(
  ports: WalletCheckPorts,
  onStep: (id: WalletCheckStepId) => void
): Promise<{
  freedCoins: number
  recoveredPayments: number
  repairedProofs: number
}> {
  onStep('records')
  const status = await ports.reviewStatus()
  const stuck = await ports.releaseStuck()

  onStep('coins')
  const spendable = await ports.reviewSpendable()

  onStep('proofs')
  const proofs = await ports.checkProofs()

  onStep('missed_payments')
  const inbox = await ports.creditInbox()
  const sweep = await ports.sweepAddresses()

  return {
    freedCoins: spendable.released + stuck.released + status.restoredInputs,
    recoveredPayments: inbox.accepted + sweep.imported,
    repairedProofs: proofs.repaired
  }
}
