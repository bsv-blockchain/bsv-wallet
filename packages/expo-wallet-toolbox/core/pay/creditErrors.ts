/**
 * Why an incoming payment failed to credit.
 *
 * Double-spend and structural failures count toward the auto-accept ceiling
 * and NACK the sender. Environmental failures (offline, headers behind,
 * network) do not — they would otherwise burn both retries on a condition the
 * sender cannot fix.
 */
export type CreditFailureKind = 'environmental' | 'double_spend' | 'structural'

export function classifyCreditError(
  e: unknown,
  ctx?: { lastMissHeight?: number; offline?: boolean }
): CreditFailureKind {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (/invalid status failed|doubleSpend|double.?spend/i.test(message)) return 'double_spend'
  // Headers behind or the device offline: any credit failure is treated as
  // environmental, including "valid AtomicBEEF" which the chain tracker reports
  // for a missing root. AtomicBEEF while online with no lastMissHeight is
  // structural (bad ancestry) and falls through below.
  if (ctx?.offline) return 'environmental'
  if (ctx?.lastMissHeight != null) return 'environmental'
  if (
    /network request failed|timed? ?out|chaintracks|database is locked|database table is locked|database-locked|failed to retrieve messages|not found on refresh/i.test(
      message
    )
  )
    return 'environmental'
  return 'structural'
}

/**
 * Await getOnline once per pass. Peek last-miss at each failure, not at build.
 *
 * `getOnline()` is async: `offline: !getOnline()` is always false because a
 * Promise is truthy. Peeking (not taking) last-miss lets a miss recorded
 * during the pass classify the payment that failed because of it, and does
 * not let a joining caller steal the marker.
 */
export async function makeCreditClassifier(args: {
  getOnline: () => boolean | Promise<boolean>
  peekLastMissHeight: () => number | undefined
}): Promise<(e: unknown) => CreditFailureKind> {
  const offline = !(await args.getOnline())
  return e => classifyCreditError(e, { offline, lastMissHeight: args.peekLastMissHeight() })
}
