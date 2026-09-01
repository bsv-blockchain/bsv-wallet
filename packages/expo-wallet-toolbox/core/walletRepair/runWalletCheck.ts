/**
 * Ordered Check-my-wallet repair steps.
 *
 * Records first so phantom spendable outputs do not poison later sends.
 * freedCoins = reviewSpendable.released + releaseStuck.released + reviewStatus.restoredInputs
 *
 * A port throw marks that step error; later steps still run.
 */

export type WalletCheckStepId =
  | 'online'
  | 'records'
  | 'coins'
  | 'proofs'
  | 'missed_payments'
  | 'backup'
  | 'phrase_backup'

/**
 * `error` means the step could not run — the thing to do about it is try again.
 * `attention` means it ran and the answer is one the user should see: offline,
 * no backup on the server, no recovery phrase written down. Conflating the two
 * would offer Retry for a state that retrying cannot change, and would let a
 * wallet with no backup report that everything looks good.
 */
export type WalletCheckStepStatus = 'ok' | 'error' | 'attention'
export type WalletCheckStepResult = { id: WalletCheckStepId; status: WalletCheckStepStatus }

export interface WalletCheckPorts {
  /** Connectivity. Everything below it depends on this being true. */
  checkOnline: () => Promise<{ online: boolean }>
  /** Whether this device has a backup on the private server. */
  checkBackup: () => Promise<{ enabled: boolean; uploaded: boolean }>
  /** Whether the recovery phrase was written down or the shares printed. */
  checkPhraseBackup: () => Promise<{ backedUp: boolean }>
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

function pushStatus(
  steps: WalletCheckStepResult[],
  onStepDone: ((id: WalletCheckStepId, status: WalletCheckStepStatus) => void) | undefined,
  id: WalletCheckStepId,
  status: WalletCheckStepStatus
): void {
  steps.push({ id, status })
  onStepDone?.(id, status)
}

function pushStep(
  steps: WalletCheckStepResult[],
  onStepDone: ((id: WalletCheckStepId, status: WalletCheckStepStatus) => void) | undefined,
  id: WalletCheckStepId,
  ok: boolean
): void {
  pushStatus(steps, onStepDone, id, ok ? 'ok' : 'error')
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
  /** Every step ran. Governs whether Retry is worth offering. */
  allOk: boolean
  /** Every step ran AND had nothing to flag. Governs the reassuring copy. */
  allClear: boolean
}> {
  const steps: WalletCheckStepResult[] = []

  onStep('online')
  const online = await settle(() => ports.checkOnline(), { online: false })
  pushStatus(steps, onStepDone, 'online', !online.ok ? 'error' : online.value.online ? 'ok' : 'attention')

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

  onStep('backup')
  const backup = await settle(() => ports.checkBackup(), { enabled: false, uploaded: false })
  pushStatus(
    steps,
    onStepDone,
    'backup',
    !backup.ok ? 'error' : backup.value.enabled && backup.value.uploaded ? 'ok' : 'attention'
  )

  onStep('phrase_backup')
  const phrase = await settle(() => ports.checkPhraseBackup(), { backedUp: false })
  pushStatus(steps, onStepDone, 'phrase_backup', !phrase.ok ? 'error' : phrase.value.backedUp ? 'ok' : 'attention')

  return {
    freedCoins: spendable.value.released + stuck.value.released + status.value.restoredInputs,
    recoveredPayments: inbox.value.accepted + sweep.value.imported,
    repairedProofs: proofs.value.repaired,
    steps,
    allOk: steps.every(s => s.status !== 'error'),
    allClear: steps.every(s => s.status === 'ok')
  }
}
