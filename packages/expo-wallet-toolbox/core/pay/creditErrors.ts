/**
 * Why an incoming payment failed to credit.
 *
 * Double-spend and structural failures count toward the auto-accept ceiling
 * and NACK the sender. Environmental failures (offline, headers behind,
 * network) do not — they would otherwise burn both retries on a condition the
 * sender cannot fix.
 */
export type CreditFailureKind = 'environmental' | 'double_spend' | 'structural'

/**
 * internalizeAction (wallet-toolbox-mobile 2.14.7 and later) posts an unproven payment
 * itself and throws WERR_REVIEW_ACTIONS, crediting nothing, when the post fails. Its
 * `reviewActionResults` say why: a double spend, an invalid transaction, or, when every
 * result is a service error, no broadcaster could be reached.
 */
function classifyFailedPost(e: unknown): CreditFailureKind | undefined {
  const review = e as { name?: unknown; reviewActionResults?: unknown } | null
  if (review?.name !== 'WERR_REVIEW_ACTIONS' || !Array.isArray(review.reviewActionResults)) return undefined
  const statuses = review.reviewActionResults.map(r => (r as { status?: unknown } | null)?.status)
  if (statuses.length === 0) return undefined
  if (statuses.includes('doubleSpend')) return 'double_spend'
  if (statuses.every(s => s === 'serviceError')) return 'environmental'
  return 'structural'
}

/**
 * Why internalizeAction's post of a payment failed, in words, for callers that
 * keep only a message: WERR_REVIEW_ACTIONS's own message does not say. The
 * environmental wording is matched by `isRetriableInternalizeFailure`.
 */
export function failedPostReason(e: unknown): string | undefined {
  switch (classifyFailedPost(e)) {
    case 'environmental':
      return 'The payment could not be broadcast: no broadcaster could be reached'
    case 'double_spend':
      return 'The payment could not be broadcast: the network reported a double spend'
    case 'structural':
      return 'The payment could not be broadcast: the network rejected the transaction'
    default:
      return undefined
  }
}

export function classifyCreditError(
  e: unknown,
  ctx?: { lastMissHeight?: number; offline?: boolean }
): CreditFailureKind {
  const failedPost = classifyFailedPost(e)
  if (failedPost) return failedPost
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (/invalid status failed|doubleSpend|double.?spend/i.test(message)) return 'double_spend'
  // Headers behind or the device offline: any credit failure is treated as
  // environmental, including "valid AtomicBEEF" which the chain tracker reports
  // for a missing root. AtomicBEEF while online with no lastMissHeight is
  // structural (bad ancestry) and falls through below.
  if (ctx?.offline) return 'environmental'
  if (ctx?.lastMissHeight != null) return 'environmental'
  if (
    /network request failed|timed? ?out|chaintracks|database is locked|database table is locked|database-locked|failed to retrieve messages|not found on refresh|no broadcaster could be reached/i.test(
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
