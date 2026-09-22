/**
 * Whether the wallet re-locks when it leaves the foreground.
 *
 * Off by default, which keeps the shipped behaviour exactly as it was: one
 * ceremony at wallet instantiation, held until the process dies. That default
 * is not laziness — a wallet built around fast Pay / Get paid taps is one
 * people open in front of a cashier, and re-authenticating every time a
 * notification pulled them away would be felt on every single payment.
 *
 * On, it answers the one threat the per-process model really does miss: a
 * phone handed to someone else while the wallet is already open. The grace
 * period exists because "backgrounded" also describes the camera sheet, the
 * share sheet, and the OS asking about notifications — re-locking on those
 * would make the setting unusable rather than strict.
 *
 * Stored in AsyncStorage, not SecureStore: it is a comfort setting, not a
 * secret, and nothing an attacker could learn from it is worth a keychain read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'wallet_lock_on_background'

/**
 * How long the app may sit in the background before the KEK is dropped.
 *
 * Long enough to survive a photo picker or a glance at a notification, short
 * enough that a phone left on a table is not still open by the time someone
 * else picks it up.
 */
export const AUTO_LOCK_GRACE_MS = 30_000

const listeners = new Set<() => void>()
let enabled = false

export function isAutoLockEnabled(): boolean {
  return enabled
}

export function setAutoLockEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  listeners.forEach(l => l())
  // Fire-and-forget: the preference is live in memory already, and a failed
  // write costs the next launch's default, never this session's behaviour.
  void AsyncStorage.setItem(STORAGE_KEY, next ? '1' : '0').catch(() => {})
}

export function subscribeAutoLock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Restore the stored preference. Call once at startup; safe to call twice. */
export async function loadAutoLockPref(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY)
    const next = stored === '1'
    if (next !== enabled) {
      enabled = next
      listeners.forEach(l => l())
    }
  } catch {
    // Keep the default. A wallet that cannot read a preference is not a wallet
    // that should refuse to open.
  }
}
