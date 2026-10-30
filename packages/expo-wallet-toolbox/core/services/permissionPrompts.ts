import type { SigningPolicyPermissionsManager } from './signingPermissionPolicy'

/** A token module's prompt function (BTMS `promptHandler`, Mandala `requestTokenAccess`). */
export type TokenPromptHandler = (originator: string, message: string) => Promise<boolean>

/**
 * Ties a token-module prompt function to the build that created it. Once the
 * build's manager is retired the wrapper resolves `false` without enqueueing,
 * so a module call that was already inside `onRequest` (mid-lookup) when the
 * wallet was replaced ends with its usual denial instead of raising a sheet
 * for a wallet that is gone. The flag is set in the same synchronous step as
 * `manager.retire()`. A check in the module's `onRequest` wrapper would not be
 * enough: a call already inside it has passed that check.
 */
export function guardTokenPromptHandlers(handlers: { btms: TokenPromptHandler; mandala: TokenPromptHandler }): {
  btms: TokenPromptHandler
  mandala: TokenPromptHandler
  /** Hand to `manager.onRetire`. */
  retire: () => void
} {
  let retired = false
  const guarded = (handler: TokenPromptHandler): TokenPromptHandler => {
    return (originator, message) => (retired ? Promise.resolve(false) : handler(originator, message))
  }
  return {
    btms: guarded(handlers.btms),
    mandala: guarded(handlers.mandala),
    retire: () => {
      retired = true
    }
  }
}

/** The places a withdrawal empties. */
export interface PromptSinks {
  /** Queues whose items are answered through a manager (protocol, basket, certificate, spending, group). */
  managerQueues: Array<{ clear: () => void }>
  /** Queues whose items hold a promise (BTMS, Mandala); each is resolved `false`. */
  tokenQueues: Array<{ clear: (onEach: (item: { resolve: (approved: boolean) => void }) => void) => void }>
  /** Anything else holding a question for the user (pending connection requests). */
  others: Iterable<() => void>
}

/**
 * Withdraws every prompt that belonged to wallets that have gone. The old
 * managers are retired FIRST, synchronously, so a call still parked inside one
 * (on a manifest fetch, the grouped lock, a token lookup) cannot raise a prompt
 * after the sweep; then every request they still hold is denied and every queue
 * is emptied, which also closes the modals and gives focus back.
 */
export function withdrawPrompts(oldManagers: SigningPolicyPermissionsManager[], sinks: PromptSinks): void {
  for (const manager of oldManagers) manager.retire()
  for (const manager of oldManagers) manager.denyAllActiveRequests()
  for (const queue of sinks.managerQueues) queue.clear()
  for (const queue of sinks.tokenQueues) queue.clear(item => item.resolve(false))
  for (const other of sinks.others) {
    try {
      other()
    } catch (error) {
      console.warn('[permissions] withdrawing a prompt failed', error)
    }
  }
}

export interface SpendingPromptArgs {
  requestID?: string
  originator: string
  reason?: string
  renewal?: boolean
  spending?: { satoshis: number; lineItems?: any[] }
}

export interface SpendingPromptDeps<Item> {
  /** Re-reads the persisted auto-approve threshold (an AsyncStorage read). */
  loadThreshold: () => Promise<void>
  /** The auto-approve decision for this spend. */
  decide: (originator: string, satoshis: number) => { approve: boolean; reason?: string | null }
  /** Records an auto-approved spend in the ledger. */
  recordAutoApproved: (originator: string, satoshis: number) => void
  enqueue: (item: Item) => void
  /** Only for a request that arrives without the manager it was raised on. */
  currentManager: () => SigningPolicyPermissionsManager | undefined
}

/**
 * The wallet's reaction to a spending-authorization request: auto-grant a small
 * one, otherwise queue it for the sheet. `manager` is the one the request was
 * raised on (the callback is bound per manager). The threshold read is async,
 * so a withdrawal can land inside it; after it, and before the ledger record,
 * the auto-grant or the enqueue, the manager must still hold the request, or
 * the request is gone and nothing more happens. The auto-grant also targets
 * that same manager: a replacement manager restarts its `spend:…:request:N`
 * counter, so the current one must never be asked to grant an old ID.
 */
export async function handleSpendingPrompt<Item>(
  args: SpendingPromptArgs,
  manager: SigningPolicyPermissionsManager | undefined,
  deps: SpendingPromptDeps<Item>
): Promise<void> {
  const { requestID, originator, reason, renewal, spending } = args
  if (!requestID || !spending) return

  await deps.loadThreshold()
  if (manager && !manager.hasActiveRequest(requestID)) return

  const decision = deps.decide(originator, spending.satoshis)
  if (decision.approve) {
    deps.recordAutoApproved(originator, spending.satoshis)
    if (__DEV__) console.log(`[spend-auth] AUTO-APPROVING requestID=${requestID} sats=${spending.satoshis}`)
    const target = manager ?? deps.currentManager()
    target?.grantPermission({ requestID, ephemeral: true, amount: spending.satoshis }).catch(() => {})
    return
  }
  if (__DEV__) {
    console.log(
      `[spend-auth] not eligible (${decision.reason}) → manual modal requestID=${requestID} sats=${spending.satoshis}`
    )
  }

  deps.enqueue({
    requestID,
    originator,
    description: reason,
    transactionAmount: 0,
    totalPastSpending: 0,
    amountPreviouslyAuthorized: 0,
    authorizationAmount: spending.satoshis,
    renewal,
    lineItems: spending.lineItems || [],
    manager
  } as Item)
}
