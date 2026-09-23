/**
 * The BSV half of demo mode: the two reads `WalletHomeScreen` makes for the
 * balance figure and the activity list, answered from the demo ledger.
 *
 * DEV-ONLY. These are not a `WalletInterface` and deliberately are not one —
 * demo mode substitutes the two READS the home screen performs, not the wallet
 * itself, so no signing, key or storage path can ever be reached through here.
 */
import { demoActions, demoSatoshis, demoTotalActions, type DemoAction } from './demoLedger'

/** Shape of `permissionsManager.listActions`' result, for the home screen. */
export interface DemoListActionsResult {
  totalActions: number
  actions: DemoAction[]
}

export function demoListActions(args: { limit?: number; offset?: number } = {}): DemoListActionsResult {
  const { limit, offset = 0 } = args
  return { totalActions: demoTotalActions(), actions: demoActions(limit, offset) }
}

/** Spendable satoshis — what `readWalletBalance`/`listOutputs` would total. */
export function demoWalletBalance(): number {
  return demoSatoshis()
}
