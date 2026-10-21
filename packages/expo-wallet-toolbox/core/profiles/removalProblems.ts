/**
 * What to tell someone whose profile removal was refused or failed: the i18n
 * keys of one paragraph per kind of reason (core/i18n/translations.tsx,
 * profile_remove_*). Shared by every app's Profile screen so the copy can't
 * drift from what core/profiles/removeProfile actually checks.
 */
import type { RemovalBlocker } from './assertProfileEmpty'
import type { ProfileRemovalCheck, RemoveProfileResult } from './removeProfile'

/** What can stand in the way of removing a profile, grouped the way the user is told about it. */
const FUNDS_BLOCKERS: RemovalBlocker[] = ['spendable-outputs', 'token-balance']
const PENDING_BLOCKERS: RemovalBlocker[] = [
  'pending-transactions',
  'offline-queue',
  'token-settlements',
  'localpay-pending',
  'peerpay-outbox',
  'inbox-pending'
]

export type RemovalProblem =
  | Exclude<ProfileRemovalCheck, { kind: 'ok' }>
  | Exclude<RemoveProfileResult, { kind: 'removed' }>

/** The i18n keys that explain a refusal or failure, one paragraph per kind of reason. */
export function removalProblemKeys(problem: RemovalProblem): string[] {
  if (problem.kind === 'refused')
    return [problem.reason === 'offline' ? 'profile_remove_offline' : 'profile_remove_failed']
  if (problem.kind === 'handle-failed') return ['profile_remove_failed_handle']
  if (problem.kind === 'blocked') {
    const keys: string[] = []
    const has = (group: RemovalBlocker[]) => problem.reasons.some(r => group.includes(r))
    if (has(FUNDS_BLOCKERS)) keys.push('profile_remove_blocked_funds')
    if (has(PENDING_BLOCKERS)) keys.push('profile_remove_blocked_pending')
    // Funds or pending activity in the databases of its other networks, which the open one never shows.
    if (problem.reasons.includes('other-network')) keys.push('profile_remove_blocked_network')
    // An unfinished handle write is the same thing to the user as a handle that would not release.
    if (problem.reasons.includes('handle-journal')) keys.push('profile_remove_failed_handle')
    if (problem.reasons.includes('check-failed')) keys.push('profile_remove_blocked_check')
    if (keys.length > 0) return keys
  }
  return ['profile_remove_failed']
}
