/**
 * Every calendar date this device has issued a conventional-receive address for.
 *
 * XR-055. `pay/watchlist.ts` prunes by a 7-day calendar age no matter how recently an
 * address was swept — that bound exists to keep the BACKGROUND sweeper's polling cost
 * bounded, and is deliberately left alone here (see watchlist.ts's own "spec open question
 * 5" note and its pinned-bounds test). But it means the watchlist cannot answer "which
 * dates has this wallet ever issued an address for", which is exactly what a payer-sat-on-
 * it-for-a-month recovery scan needs: a payer who pays a legitimately-displayed address more
 * than MAX_WATCH_DAYS/MAX_RECOVERY_DAYS after issue had no shipped path back to
 * internalizeAction once the watchlist entry aged out.
 *
 * This store answers that question. It is capped by COUNT, not calendar age — an issued
 * date is worth remembering indefinitely, since sweepAddress (core/pay/rails/address.ts) is
 * idempotent and cheap to retry for a date that turns out to hold nothing — and it rides the
 * encrypted backup envelope (core/backup/appData.ts) so a restored device CAN resume
 * scanning every date this wallet has ever shown, not just the ones the restoring device
 * itself issued — but only for a date recorded in a window where some OTHER entity change
 * also happened to get pushed; see appData.ts's own "KNOWN, STILL-OPEN GAP" note for why a
 * date issued with nothing else going on in the wallet at the time can still fail to reach
 * the log at all.
 */

export const RECEIVE_HISTORY_KEY = 'pay_receive_issued_dates'

/**
 * Count cap, not calendar-age cap (see module docstring). One entry is a ~10-byte
 * YYYY-MM-DD string, so even this many costs nothing to store or to carry in a backup
 * envelope — it exists only so a pathological caller cannot grow this list forever, not
 * because any realistic wallet would approach it.
 */
export const MAX_RECEIVE_HISTORY = 3650

export interface KVStorage {
  getKeyValue (k: string): Promise<string | undefined>
  setKeyValue (k: string, v: string): Promise<void>
}

// Same discipline as localpay/pending.ts and pay/watchlist.ts: every read-modify-write on
// this single storage key runs through one chain, or a write built from a stale read
// silently drops an entry.
let queueLock: Promise<unknown> = Promise.resolve()

function withQueueLock<T> (fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn)
  queueLock = run.catch(() => undefined)
  return run
}

async function readAll (storage: KVStorage): Promise<string[]> {
  const raw = await storage.getKeyValue(RECEIVE_HISTORY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

function normalise (dates: Iterable<string>): string[] {
  return [...new Set(dates)].sort().slice(-MAX_RECEIVE_HISTORY)
}

/**
 * Record a newly issued date, deduplicated. Called from the same place AddressReceive.tsx
 * already calls watchAddress — every address this app has shown the user gets its date
 * remembered here too, independent of whether that address also survives the watchlist's
 * own 7-day prune.
 */
export async function recordIssuedDate (storage: KVStorage, date: string): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    if (all.includes(date)) return
    await storage.setKeyValue(RECEIVE_HISTORY_KEY, JSON.stringify(normalise([...all, date])))
  })
}

/** Every recorded date, deduplicated and sorted ascending. */
export async function getIssuedDates (storage: KVStorage): Promise<string[]> {
  return normalise(await readAll(storage))
}

/**
 * Replace the whole list. Used only by backup restore (core/backup/appData.ts), which has
 * already merged every device's own history into one deduplicated, capped list and wants a
 * single write rather than N individual `recordIssuedDate` inserts.
 */
export async function setIssuedDates (storage: KVStorage, dates: string[]): Promise<void> {
  return withQueueLock(async () => {
    await storage.setKeyValue(RECEIVE_HISTORY_KEY, JSON.stringify(normalise(dates)))
  })
}
