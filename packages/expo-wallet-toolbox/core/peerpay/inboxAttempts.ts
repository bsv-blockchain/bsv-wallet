/**
 * Persisted auto-accept attempt state, keyed by inbox message id.
 *
 * Same KV pattern as the outbox: one JSON blob under a fixed key so HandleReceive
 * and TaskCreditInbox share a ceiling instead of each burning MAX_AUTO_ATTEMPTS.
 */
import type { InboxAttempt } from '../pay/rails/handle'

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

export const INBOX_ATTEMPTS_KEY = 'peerpay_inbox_attempts'

export async function loadInboxAttempts(storage: StorageLike): Promise<Record<string, InboxAttempt>> {
  try {
    const raw = await storage.getKeyValue(INBOX_ATTEMPTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, InboxAttempt>
  } catch {
    return {}
  }
}

export async function saveInboxAttempts(
  storage: StorageLike,
  map: Record<string, InboxAttempt>
): Promise<void> {
  await storage.setKeyValue(INBOX_ATTEMPTS_KEY, JSON.stringify(map))
}
