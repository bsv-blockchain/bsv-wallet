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

export async function runWalletCheck(
  ports: WalletCheckPorts,
  onStep: (id: WalletCheckStepId) => void
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
  steps.push({ id: 'records', status: status.ok && stuck.ok ? 'ok' : 'error' })

  onStep('coins')
  const spendable = await settle(() => ports.reviewSpendable(), { released: 0, recovered: 0 })
  steps.push({ id: 'coins', status: spendable.ok ? 'ok' : 'error' })

  onStep('proofs')
  const proofs = await settle(() => ports.checkProofs(), { repaired: 0 })
  steps.push({ id: 'proofs', status: proofs.ok ? 'ok' : 'error' })

  onStep('missed_payments')
  const inbox = await settle(() => ports.creditInbox(), { accepted: 0 })
  const sweep = await settle(() => ports.sweepAddresses(), { imported: 0 })
  steps.push({ id: 'missed_payments', status: inbox.ok && sweep.ok ? 'ok' : 'error' })

  return {
    freedCoins: spendable.value.released + stuck.value.released + status.value.restoredInputs,
    recoveredPayments: inbox.value.accepted + sweep.value.imported,
    repairedProofs: proofs.value.repaired,
    steps,
    allOk: steps.every(s => s.status === 'ok')
  }
}
