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
 * `skipped` means the user tapped past it. Not an error, and not clear either:
 * a skipped check is one whose answer nobody knows.
 */
export type WalletCheckStepStatus = 'ok' | 'error' | 'attention' | 'skipped'
export type WalletCheckStepResult = { id: WalletCheckStepId; status: WalletCheckStepStatus }

/**
 * Lets the user tap past a step. `isSkipped` is read before a step starts;
 * `whenSkipped` races a step already in flight, so the long coins scan can be
 * abandoned rather than watched. The underlying request is not cancellable —
 * it finishes in the background and its result is discarded — but the user is
 * no longer held by it, which is the point.
 */
export interface WalletCheckSkips {
  isSkipped: (id: WalletCheckStepId) => boolean
  whenSkipped: (id: WalletCheckStepId) => Promise<void>
}

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

type StepOutcome<T> = { skipped: true; value: T } | { skipped: false; ok: boolean; value: T }

/** Run a step's work unless the user has skipped it, or skips it mid-flight. */
async function guard<T>(
  skips: WalletCheckSkips | undefined,
  id: WalletCheckStepId,
  fallback: T,
  work: () => Promise<{ ok: boolean; value: T }>
): Promise<StepOutcome<T>> {
  if (skips?.isSkipped(id) === true) return { skipped: true, value: fallback }
  if (!skips) return { skipped: false, ...(await work()) }
  const skipSignal = skips.whenSkipped(id).then(() => 'skipped' as const)
  const result = await Promise.race([work(), skipSignal])
  if (result === 'skipped') return { skipped: true, value: fallback }
  return { skipped: false, ...result }
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
  onStepDone?: (id: WalletCheckStepId, status: WalletCheckStepStatus) => void,
  skips?: WalletCheckSkips
): Promise<{
  freedCoins: number
  recoveredPayments: number
  repairedProofs: number
  steps: WalletCheckStepResult[]
  /** Every step ran. Governs whether Retry is worth offering. */
  allOk: boolean
  /**
   * Nothing was flagged, and something was actually checked. Governs the
   * reassuring copy.
   *
   * A skipped step does not count against it: the user chose to move past that
   * one, and answering their choice with "some checks need your attention"
   * treats their own decision as a problem to be fixed. It does not count
   * FOR it either — a run where everything was skipped verified nothing, and
   * has no business claiming the wallet looks fine.
   */
  allClear: boolean
}> {
  const steps: WalletCheckStepResult[] = []

  const record = (id: WalletCheckStepId, outcome: { skipped: boolean }, status: () => WalletCheckStepStatus) => {
    pushStatus(steps, onStepDone, id, outcome.skipped ? 'skipped' : status())
  }

  onStep('online')
  const online = await guard(skips, 'online', { online: false }, () =>
    settle(() => ports.checkOnline(), { online: false })
  )
  record('online', online, () =>
    !(online as { ok?: boolean }).ok ? 'error' : online.value.online ? 'ok' : 'attention'
  )

  onStep('records')
  const records = await guard(skips, 'records', { failedTxs: 0, restoredInputs: 0, stuckReleased: 0 }, async () => {
    const status = await settle(() => ports.reviewStatus(), { failedTxs: 0, restoredInputs: 0 })
    const stuck = await settle(() => ports.releaseStuck(), { released: 0 })
    return { ok: status.ok && stuck.ok, value: { ...status.value, stuckReleased: stuck.value.released } }
  })
  record('records', records, () => ((records as { ok?: boolean }).ok === true ? 'ok' : 'error'))

  onStep('proofs')
  const proofs = await guard(skips, 'proofs', { repaired: 0 }, () =>
    settle(() => ports.checkProofs(), { repaired: 0 })
  )
  record('proofs', proofs, () => ((proofs as { ok?: boolean }).ok === true ? 'ok' : 'error'))

  onStep('backup')
  const backup = await guard(skips, 'backup', { enabled: false, uploaded: false }, () =>
    settle(() => ports.checkBackup(), { enabled: false, uploaded: false })
  )
  record('backup', backup, () =>
    !(backup as { ok?: boolean }).ok ? 'error' : backup.value.enabled && backup.value.uploaded ? 'ok' : 'attention'
  )

  onStep('phrase_backup')
  const phrase = await guard(skips, 'phrase_backup', { backedUp: false }, () =>
    settle(() => ports.checkPhraseBackup(), { backedUp: false })
  )
  record('phrase_backup', phrase, () =>
    !(phrase as { ok?: boolean }).ok ? 'error' : phrase.value.backedUp ? 'ok' : 'attention'
  )

  onStep('missed_payments')
  const missed = await guard(skips, 'missed_payments', { accepted: 0, imported: 0 }, async () => {
    const inbox = await settle(() => ports.creditInbox(), { accepted: 0 })
    const sweep = await settle(() => ports.sweepAddresses(), { imported: 0 })
    return { ok: inbox.ok && sweep.ok, value: { accepted: inbox.value.accepted, imported: sweep.value.imported } }
  })
  record('missed_payments', missed, () => ((missed as { ok?: boolean }).ok === true ? 'ok' : 'error'))

  // Last on purpose: it is the only step that can take minutes (one network
  // call per output), so everything quick has already reported by the time the
  // user is waiting on anything. Still after records, which is what clears the
  // phantom outputs this step would otherwise scan.
  onStep('coins')
  const spendable = await guard(skips, 'coins', { released: 0, recovered: 0 }, () =>
    settle(() => ports.reviewSpendable(), { released: 0, recovered: 0 })
  )
  record('coins', spendable, () => ((spendable as { ok?: boolean }).ok === true ? 'ok' : 'error'))

  return {
    freedCoins: spendable.value.released + records.value.stuckReleased + records.value.restoredInputs,
    recoveredPayments: missed.value.accepted + missed.value.imported,
    repairedProofs: proofs.value.repaired,
    steps,
    allOk: steps.every(s => s.status !== 'error'),
    allClear: steps.some(s => s.status === 'ok') && steps.every(s => s.status === 'ok' || s.status === 'skipped')
  }
}
