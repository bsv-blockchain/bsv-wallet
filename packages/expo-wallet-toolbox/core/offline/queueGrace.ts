/**
 * Which queued payments are worth telling the user about.
 *
 * "Waiting to be broadcast — nothing is settled until they do" is true of a
 * payment queued underground for an hour. It is not what a user needs to read
 * for the half second between a payment joining the queue and the drain posting
 * it, which is what they see when they release one while online: the banner
 * flashes up and vanishes, having claimed a problem that never existed.
 *
 * So while online, a queued row stays quiet for a grace period. Offline there
 * is no grace: nothing will post it until the network comes back, and that is
 * the whole point of saying so. A row still queued after the grace has earned
 * the banner — by then it really is stuck on something.
 *
 * The caller is told when to look again (`nextCheckMs`), because a row that is
 * merely young becomes newsworthy by the passage of time alone, and nothing
 * else would wake the screen to notice.
 */

/** Long enough to cover a normal post, short enough that a stall still surfaces fast. */
export const QUEUE_GRACE_MS = 6000

export type GraceRow = { status: string; created_at?: string; updated_at?: string }

function ageMs(row: GraceRow, nowMs: number): number {
  const stamp = row.updated_at ?? row.created_at
  if (!stamp) return Number.POSITIVE_INFINITY
  const t = new Date(stamp).getTime()
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  // A clock skewed the wrong way must not hide the banner forever.
  return Math.max(0, nowMs - t)
}

export function partitionQueueByGrace<T extends GraceRow>(
  rows: T[],
  args: { online: boolean; nowMs: number; graceMs?: number }
): { shown: T[]; nextCheckMs?: number } {
  const graceMs = args.graceMs ?? QUEUE_GRACE_MS
  if (!args.online) return { shown: rows }

  const shown: T[] = []
  let soonest: number | undefined
  for (const row of rows) {
    const remaining = graceMs - ageMs(row, args.nowMs)
    if (remaining <= 0) {
      shown.push(row)
      continue
    }
    soonest = soonest === undefined ? remaining : Math.min(soonest, remaining)
  }
  return soonest === undefined ? { shown } : { shown, nextCheckMs: soonest }
}
