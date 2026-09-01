/**
 * Ordered Check-my-wallet repair steps.
 *
 * Records first so phantom spendable outputs do not poison later sends.
 * freedCoins = reviewSpendable.released + releaseStuck.released + reviewStatus.restoredInputs
 *
 * A port throw marks that step error; later steps still run.
 */

export type WalletCheckStepId = 'coins' | 'proofs' | 'records' | 'missed_payments'
export type WalletCheckStepStatus = 'ok' | 'error'
export type WalletCheckStepResult = { id: WalletCheckStepId; status: WalletCheckStepStatus }

export interface WalletCheckPorts {
  reviewSpendable: () => Promise<{ released: number; recovered: number }>
  checkProofs: () => Promise<{ repaired: number }>
  reviewStatus: () => Promise<{ failedTxs: number; restoredInputs: number }>
  releaseStuck: () => Promise<{ released: number }>
  creditInbox: () => Promise<{ accepted: number }>
  sweepAddresses: () => Promise<{ imported: number }>
}

async function settle<T>(fn: () => Promise<T>, fallback: T): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await fn() }
  } catch {
    return { ok: false, value: fallback }
  }
}

function pushStep(
  steps: WalletCheckStepResult[],
  onStepDone: ((id: WalletCheckStepId, status: WalletCheckStepStatus) => void) | undefined,
  id: WalletCheckStepId,
  ok: boolean
): void {
  const status: WalletCheckStepStatus = ok ? 'ok' : 'error'
  steps.push({ id, status })
  onStepDone?.(id, status)
}

export async function runWalletCheck(
  ports: WalletCheckPorts,
  onStep: (id: WalletCheckStepId) => void,
  /**
   * Fired as each step settles, so a checklist can tick an item the moment it
   * finishes. Without it the per-step outcome is only knowable from the return
   * value — by which point every step has already run, and a user watching a
   * fast wallet would see four steps resolve in one frame with no record of
   * which ones actually happened.
   */
  onStepDone?: (id: WalletCheckStepId, status: WalletCheckStepStatus) => void
): Promise<{
  freedCoins: number
  recoveredPayments: number
  repairedProofs: number
  steps: WalletCheckStepResult[]
  allOk: boolean
}> {
  const steps: WalletCheckStepResult[] = []

  onStep('records')
  const status = await settle(() => ports.reviewStatus(), { failedTxs: 0, restoredInputs: 0 })
  const stuck = await settle(() => ports.releaseStuck(), { released: 0 })
  pushStep(steps, onStepDone, 'records', status.ok && stuck.ok)

  onStep('coins')
  const spendable = await settle(() => ports.reviewSpendable(), { released: 0, recovered: 0 })
  pushStep(steps, onStepDone, 'coins', spendable.ok)

  onStep('proofs')
  const proofs = await settle(() => ports.checkProofs(), { repaired: 0 })
  pushStep(steps, onStepDone, 'proofs', proofs.ok)

  onStep('missed_payments')
  const inbox = await settle(() => ports.creditInbox(), { accepted: 0 })
  const sweep = await settle(() => ports.sweepAddresses(), { imported: 0 })
  pushStep(steps, onStepDone, 'missed_payments', inbox.ok && sweep.ok)

  return {
    freedCoins: spendable.value.released + stuck.value.released + status.value.restoredInputs,
    recoveredPayments: inbox.value.accepted + sweep.value.imported,
    repairedProofs: proofs.value.repaired,
    steps,
    allOk: steps.every(s => s.status === 'ok')
  }
}
