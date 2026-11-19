/**
 * Which FAILED Vault spends (withdrawals, re-locks) hold a pending key removal
 * open in finalizeVaultKeyRemoval.
 *
 * The tombstone exists so that no output the removed key can still open is
 * missed. A failed spend is a risk to that only if it may yet be on the
 * network, creating an output committed to the old key set. Refusing on every
 * failed spend ever recorded (the earlier rule) could never clear: a failed
 * action stays in the wallet's history for good, so one aborted re-lock
 * attempt, or one failed withdrawal months before, kept the removal pending
 * after its re-lock was mined.
 *
 * A failed spend blocks only when BOTH hold:
 *
 * 1. It has a transaction ID. A Vault input is signed by the card and by
 *    nothing else, and the wallet assigns the ID at signAction. A spend with
 *    none was aborted before any signature: no transaction with its inputs can
 *    exist.
 * 2. It began at or after the removal did. finalize clears the tombstone only
 *    with an ACCEPTED re-lock and two scans that find no output authorizing
 *    the removed key, so every output an earlier spend could have consumed is
 *    spent by an accepted transaction: the earlier one can no longer confirm.
 *    (Should an accepted re-lock still be dropped, its sources return as
 *    outputs committed to the removed key, which the coverage badge offers to
 *    re-lock: the owner decision recorded at ACCEPTED_ACTION_STATUSES.)
 *
 * Fail closed where the spend cannot be placed in time: a signed spend with no
 * readable creation time, or a removal with no readable start, blocks.
 */
export function failedVaultSpendBlocksRemoval(
  action: { txid?: string; created_at?: string | Date | number },
  removalStartedAt: number
): boolean {
  if (typeof action.txid !== 'string' || action.txid === '') return false
  const at = action.created_at
  const created =
    at instanceof Date ? at.getTime() : typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN
  if (!Number.isFinite(created) || !Number.isFinite(removalStartedAt)) return true
  return created >= removalStartedAt
}
