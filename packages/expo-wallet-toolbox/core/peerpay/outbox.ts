/**
 * PeerPay Outbox — Persistent Outbound Payment Token Queue
 *
 * Outbound PeerPay payments are persisted to the wallet's key_value_store table
 * BEFORE the payment token is delivered to the recipient's MessageBox. This ensures
 * the derivation data (derivationPrefix, derivationSuffix, AtomicBEEF) is never
 * lost if the app crashes or loses connectivity between transaction broadcast and
 * message delivery.
 *
 * Storage format: a JSON array stored under the key "peerpay_outbox".
 * Each entry includes the full PaymentToken plus metadata for tracking delivery state.
 *
 * Unsent entries persist until dismissed; sent entries are retained for
 * SENT_RETENTION_MS then pruned. Retry is manual — the UI lists unsent only.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  /** `${timestamp}_${recipientKey.slice(0, 8)}`, with a suffix on collision. */
  id: string
  /** ISO 8601 creation timestamp */
  createdAt: string
  /** Recipient identity key (hex compressed pubkey) */
  recipient: string
  /** Full payment token — stored in its entirety so retry needs no wallet round-trip */
  token: {
    customInstructions: {
      derivationPrefix: string
      derivationSuffix: string
    }
    transaction: number[]
    amount: number
    /** User's note; delivered inside the token and shown by the recipient. */
    note?: string
    /**
     * Which output pays the recipient. Omitted on a fresh send, where the rail
     * pins the payment to output 0; carried on a rebuild, where the index is
     * read back from the action rather than assumed.
     */
    outputIndex?: number
  }
  /** The MessageBox host URL used at creation time */
  messageBoxUrl: string
  /**
   * The RECIPIENT's message-box host, when a BRC-125 link named one via its
   * `url` extension. Every re-send of this entry goes here, bypassing the
   * overlay lookup. Absent for entries minted from a bare key.
   */
  recipientHost?: string
  status: 'unsent' | 'sent'
  /** ISO 8601 timestamp of most recent delivery attempt */
  lastAttemptAt?: string
  /** Error message from the most recent failed delivery attempt */
  lastError?: string
  /**
   * Txid of the noSend transaction backing this token. Present on entries
   * minted since the deferred-broadcast flow; its absence marks a legacy entry
   * whose transaction was already broadcast at creation.
   */
  txid?: string
  /**
   * True once the token reached the recipient's message box. From that point
   * the payment is considered handed over: retry only re-attempts the
   * broadcast, and cancel no longer aborts the transaction.
   */
  delivered?: boolean
  /**
   * Set immediately before sendMessage. A crash after the box accepted the
   * token can leave delivering without delivered — cancel must not abort;
   * retry re-sends (HMAC message id is idempotent).
   */
  delivering?: boolean
}

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OUTBOX_KEY = 'peerpay_outbox'

/** How long sent entries are kept as a sender-side token copy before pruning. */
export const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ── Private helpers ───────────────────────────────────────────────────────────

// A send and the background retry/prune task can update this same JSON blob.
// Serialize each storage's entire read-modify-write, not just the final write,
// so delivery checkpoints and newly saved payment tokens cannot be overwritten
// by another operation's stale snapshot. Separate wallet stores stay independent.
const mutationTails = new WeakMap<StorageLike, Promise<void>>()

function withOutboxLock<T>(storage: StorageLike, fn: () => Promise<T>): Promise<T> {
  const run = (mutationTails.get(storage) ?? Promise.resolve()).then(fn)
  // A failed storage operation must reject its caller without poisoning retries.
  mutationTails.set(
    storage,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

async function readEntries(storage: StorageLike): Promise<OutboxEntry[]> {
  // Mutations must fail closed: treating an unreadable queue as empty would
  // erase persisted tokens when the subsequent write succeeds.
  const raw = await storage.getKeyValue(OUTBOX_KEY)
  if (raw === undefined) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Outbox data is not an array')
  return parsed as OutboxEntry[]
}

async function writeEntries(storage: StorageLike, entries: OutboxEntry[]): Promise<void> {
  await storage.setKeyValue(OUTBOX_KEY, JSON.stringify(entries))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns all outbox entries (any status).
 */
export async function getOutboxEntries(storage: StorageLike): Promise<OutboxEntry[]> {
  try {
    return await readEntries(storage)
  } catch {
    // Preserve the best-effort read API; mutations use the strict reader above.
    return []
  }
}

/**
 * Persist a new outbound payment token to the outbox before delivery is attempted.
 * Returns the generated entry ID.
 */
export async function saveOutboxEntry(
  storage: StorageLike,
  params: {
    recipient: string
    token: OutboxEntry['token']
    messageBoxUrl: string
    txid?: string
    recipientHost?: string
  }
): Promise<string> {
  const { recipient, token, messageBoxUrl, txid, recipientHost } = params
  const id = `${Date.now()}_${recipient.slice(0, 8)}`
  const entry: OutboxEntry = {
    id,
    createdAt: new Date().toISOString(),
    recipient,
    token,
    messageBoxUrl,
    status: 'unsent',
    ...(txid ? { txid } : {}),
    ...(recipientHost ? { recipientHost } : {})
  }
  return withOutboxLock(storage, async () => {
    const all = await readEntries(storage)
    // Concurrent sends to the same recipient can share a millisecond. Choose
    // against the current queue while holding the lock so later updates and
    // removals still identify exactly one payment; existing IDs stay unchanged.
    const usedIds = new Set(all.map(e => e.id))
    let suffix = 0
    while (usedIds.has(entry.id)) entry.id = `${id}_${++suffix}`
    all.push(entry)
    await writeEntries(storage, all)
    return entry.id
  })
}

/**
 * Mark an entry as successfully delivered.
 * Called immediately after `sendMessage()` returns without error.
 */
export async function markOutboxSent(storage: StorageLike, id: string): Promise<void> {
  return withOutboxLock(storage, async () => {
    const all = await readEntries(storage)
    const entry = all.find(e => e.id === id)
    if (entry) {
      entry.status = 'sent'
      await writeEntries(storage, all)
    }
  })
}

/**
 * Merge a partial update into an entry.
 * Used to record `lastAttemptAt` and `lastError` on failed retry attempts.
 */
export async function updateOutboxEntry(storage: StorageLike, id: string, patch: Partial<OutboxEntry>): Promise<void> {
  return withOutboxLock(storage, async () => {
    const all = await readEntries(storage)
    const idx = all.findIndex(e => e.id === id)
    if (idx !== -1) {
      all[idx] = { ...all[idx], ...patch }
      await writeEntries(storage, all)
    }
  })
}

/**
 * Remove an entry from the outbox permanently.
 * Called when the user explicitly dismisses an entry.
 */
export async function removeOutboxEntry(storage: StorageLike, id: string): Promise<void> {
  return withOutboxLock(storage, async () => {
    const all = await readEntries(storage)
    await writeEntries(
      storage,
      all.filter(e => e.id !== id)
    )
  })
}

/**
 * True when a sent entry is past SENT_RETENTION_MS.
 * Missing createdAt on a sent entry expires immediately (legacy).
 */
export function isSentExpired(entry: OutboxEntry, now: number = Date.now()): boolean {
  if (entry.status !== 'sent') return false
  if (!entry.createdAt) return true
  const created = Date.parse(entry.createdAt)
  if (Number.isNaN(created)) return true
  return now - created > SENT_RETENTION_MS
}

/**
 * Remove only expired sent rows. Returns how many were removed.
 */
export async function pruneExpiredSent(storage: StorageLike, now: number = Date.now()): Promise<number> {
  return withOutboxLock(storage, async () => {
    const all = await readEntries(storage)
    const kept = all.filter(e => !isSentExpired(e, now))
    const removed = all.length - kept.length
    if (removed > 0) await writeEntries(storage, kept)
    return removed
  })
}

/** Entries that still need Retry/Cancel — everything not yet marked sent. */
export function unsentEntries(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter(e => e.status !== 'sent')
}
