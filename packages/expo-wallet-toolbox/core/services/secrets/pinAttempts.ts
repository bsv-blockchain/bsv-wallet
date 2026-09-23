/**
 * Wrong-PIN throttling: the control that actually defends a 6-digit PIN.
 *
 * pin.ts explains why key-stretching alone cannot save 20 bits of entropy.
 * What makes a PIN workable is that the realistic attacker is a person holding
 * the phone, entering guesses by hand, and this curve makes that hopeless long
 * before it makes the owner's life hard: five free tries covers every genuine
 * fat-finger, and by the tenth attempt the wait is half an hour.
 *
 * Nothing is ever erased. A wipe-on-N-failures policy protects a threat model
 * this wallet does not have (the recovery phrase already bounds the loss) while
 * creating one it certainly does: a child, a pocket, or a spiteful acquaintance
 * destroying a wallet whose owner never wrote the phrase down.
 *
 * The counter lives in SecureStore, not memory, so killing the app does not
 * reset it — that being the first thing anyone tries.
 */
import * as SecureStore from 'expo-secure-store'
import { envOptions, PIN_ATTEMPTS_KEY } from './storage'

export interface PinAttemptState {
  /** Consecutive failures since the last success. */
  fails: number
  /** Epoch ms of the most recent failure. */
  lastFailAt: number
}

const EMPTY: PinAttemptState = { fails: 0, lastFailAt: 0 }

/** Free attempts before any delay applies. */
export const PIN_FREE_ATTEMPTS = 5

/**
 * Delay owed after `fails` consecutive failures. Indexed from the first
 * throttled attempt; past the end of the table the last value repeats, so the
 * curve plateaus at half an hour rather than growing without bound into a
 * lockout the owner can never wait out.
 */
const DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000]

export function delayForFailures(fails: number): number {
  if (fails <= PIN_FREE_ATTEMPTS) return 0
  const idx = Math.min(fails - PIN_FREE_ATTEMPTS - 1, DELAYS_MS.length - 1)
  return DELAYS_MS[idx]
}

export async function readAttempts(): Promise<PinAttemptState> {
  try {
    const raw = await SecureStore.getItemAsync(PIN_ATTEMPTS_KEY, envOptions)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as PinAttemptState
    if (typeof parsed?.fails !== 'number' || typeof parsed?.lastFailAt !== 'number') return EMPTY
    return parsed
  } catch {
    return EMPTY
  }
}

/**
 * Milliseconds still owed before another guess is accepted, 0 when ready.
 *
 * Wall-clock based, and therefore side-steppable by a user who can change the
 * device clock — which is an unavoidable property of any on-device timer and
 * is why the failure COUNT, not the timestamp, is what persists. Winding the
 * clock forward skips one wait; it does not reset the curve, so the next wrong
 * guess lands further up it than the last.
 */
export async function lockRemainingMs(now: number = Date.now()): Promise<number> {
  const s = await readAttempts()
  const owed = delayForFailures(s.fails)
  if (owed === 0) return 0
  const elapsed = now - s.lastFailAt
  // A clock moved BACKWARDS would otherwise owe a nonsense future deadline.
  if (elapsed < 0) return owed
  return Math.max(0, owed - elapsed)
}

export async function recordFailure(now: number = Date.now()): Promise<PinAttemptState> {
  const prev = await readAttempts()
  const next: PinAttemptState = { fails: prev.fails + 1, lastFailAt: now }
  try {
    await SecureStore.setItemAsync(PIN_ATTEMPTS_KEY, JSON.stringify(next), envOptions)
  } catch {
    // A failed write must not hand the attacker a free guess, so the in-memory
    // answer still counts up; it is only the across-restart memory that is lost.
  }
  return next
}

export async function clearFailures(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_ATTEMPTS_KEY, envOptions).catch(() => {})
}
