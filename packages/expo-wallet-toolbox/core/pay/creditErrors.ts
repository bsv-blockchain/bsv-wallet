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
  if (ctx?.lastMissHeight != null || ctx?.offline) return 'environmental'
  if (/network request failed|timed? ?out|chaintracks/i.test(message)) return 'environmental'
  return 'structural'
}

/**
 * Snapshot online + last-miss once for a credit pass.
 *
 * `getOnline()` is async: `offline: !getOnline()` is always false because a
 * Promise is truthy. `takeLastMissHeight()` consumes; calling it from classify
 * would give only the first payment the miss.
 */
export async function makeCreditClassifier(args: {
  getOnline: () => boolean | Promise<boolean>
  takeLastMissHeight: () => number | undefined
}): Promise<(e: unknown) => CreditFailureKind> {
  const offline = !(await args.getOnline())
  const lastMissHeight = args.takeLastMissHeight()
  return e => classifyCreditError(e, { offline, lastMissHeight })
}
