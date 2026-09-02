/**
 * Which wallet build is allowed to publish itself.
 *
 * A network switch tears the wallet down and rebuilds it on the new chain. Two
 * things then go wrong on their own:
 *
 *  - The build in flight belongs to the OLD chain. Nothing stops it finishing
 *    and publishing its managers, storage and monitor over the top of the new
 *    ones — leaving a wallet wired half to each, which is how a mainnet balance
 *    could sit above an activity list that returned nothing.
 *  - The NEW build is refused. `buildWalletFromMnemonic` returns early while a
 *    build is in progress, so the request that carried the new chain is dropped
 *    and the stale build is the only one that ever completes.
 *
 * A generation counter answers both. Every teardown bumps it; a build captures
 * the value at its start and publishes only while it still holds. A build that
 * finishes stale says so, and the caller runs again for the chain that is
 * actually selected now.
 */

export interface BuildGeneration {
  /** Invalidate any build in flight. Returns the new generation. */
  bump(): number
  /** The generation a build starting now belongs to. */
  current(): number
  /** May a build that started at `token` still publish its results? */
  isCurrent(token: number): boolean
}

export function makeBuildGeneration(): BuildGeneration {
  let n = 0
  return {
    bump: () => ++n,
    current: () => n,
    isCurrent: (token: number) => token === n
  }
}
