export type HomeBadgeKind = 'attention' | 'unsent' | 'token_attention' | 'offline'

export type HomeBadge = { kind: HomeBadgeKind; count: number }

/** Counts of stuck work to insert as inline home-screen rows. Zero counts are omitted. */
export function homeBadges(input: {
  attention: number
  unsent: number
  offlineQueued: number
  offlineRejected: number
  /**
   * Token payments that have been waiting to settle past the stuck bound
   * (FIX M). They are not failures — the money is credited and spendable — but
   * "they said they sent it and it never confirmed" must have a surface, or the
   * only way to notice is to not notice.
   */
  tokenAttention?: number
}): HomeBadge[] {
  const badges: HomeBadge[] = []
  if (input.attention > 0) badges.push({ kind: 'attention', count: input.attention })
  if (input.unsent > 0) badges.push({ kind: 'unsent', count: input.unsent })
  if ((input.tokenAttention ?? 0) > 0) badges.push({ kind: 'token_attention', count: input.tokenAttention as number })
  const offline = input.offlineQueued + input.offlineRejected
  if (offline > 0) badges.push({ kind: 'offline', count: offline })
  return badges
}
