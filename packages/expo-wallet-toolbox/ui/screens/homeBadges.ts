export type HomeBadgeKind = 'attention' | 'unsent' | 'offline'

export type HomeBadge = { kind: HomeBadgeKind; count: number }

/** Counts of stuck work to insert as inline home-screen rows. Zero counts are omitted. */
export function homeBadges(input: {
  attention: number
  unsent: number
  offlineQueued: number
  offlineRejected: number
}): HomeBadge[] {
  const badges: HomeBadge[] = []
  if (input.attention > 0) badges.push({ kind: 'attention', count: input.attention })
  if (input.unsent > 0) badges.push({ kind: 'unsent', count: input.unsent })
  const offline = input.offlineQueued + input.offlineRejected
  if (offline > 0) badges.push({ kind: 'offline', count: offline })
  return badges
}
