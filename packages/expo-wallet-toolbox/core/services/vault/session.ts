/**
 * Run a block of token operations against a live key connection, hiding the
 * transport difference:
 *
 * - **session-based (iOS NFC):** the scan sheet is a system modal that covers
 *   the app, so you cannot collect a PIN while it is up. Callers MUST gather all
 *   user input (PIN, new PIN, nickname) BEFORE calling this; then this opens the
 *   NFC session, waits for the tap to connect, runs every token op in that one
 *   tap, and always closes the session afterwards (dismissing the sheet).
 * - **persistent (Android USB / mock):** the key is already on the reader, so
 *   `work` runs immediately; the reader's lifecycle is left untouched
 *   (WalletContext owns it for relock-on-unplug).
 *
 * `onWaiting` fires when we begin waiting for the tap, so the UI can prompt
 * "hold your key to the top of your phone". `opts.nfcMessage` is the localised
 * text the iOS scan sheet itself shows.
 *
 * This REJECTS instead of waiting forever (spec §3.3 step 2): the system sheet
 * being cancelled → user-cancelled; the session dying with no key → no-key; the
 * key leaving mid-`work` → key-removed-mid-op; and nothing at all arriving by
 * the watchdog deadline → no-key (CoreNFC caps a session at 60 s; YubiKit
 * swallows several failure paths, so no delegate fix makes this redundant).
 */
import { VaultDriver } from './driver'
import { VaultError } from './types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const DEFAULT_ATTACH_TIMEOUT_MS = 65_000

export async function withKeySession<T>(
  driver: VaultDriver,
  work: () => Promise<T>,
  onWaiting?: () => void,
  opts?: { nfcMessage?: string; attachTimeoutMs?: number }
): Promise<T> {
  if (!driver.sessionBased) {
    return work()
  }
  const connected = defer<void>()
  // Rejects when the key leaves before `work` has resolved; raced against it.
  const detached = defer<never>()
  detached.promise.catch(() => {}) // never unhandled — it only matters inside the race
  let connectedYet = false
  const off = driver.onKeyEvent(e => {
    if (e.type === 'attached') {
      connectedYet = true
      connected.resolve()
    } else if (e.type === 'session-failed') {
      connected.reject(new VaultError(e.code === 'user-cancelled' ? 'user-cancelled' : 'no-key'))
    } else if (e.type === 'detached') {
      const err = new VaultError('key-removed-mid-op', 'YubiKey removed during the operation')
      if (!connectedYet) connected.reject(err)
      detached.reject(err)
    }
  })
  const watchdog = setTimeout(
    () => connected.reject(new VaultError('no-key', 'No key connected before the NFC session deadline')),
    opts?.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
  )
  ;(watchdog as { unref?: () => void }).unref?.()
  onWaiting?.()
  driver.start(opts?.nfcMessage)
  try {
    await connected.promise
    clearTimeout(watchdog)
    return await Promise.race([work(), detached.promise])
  } finally {
    clearTimeout(watchdog)
    off()
    try {
      driver.stop()
    } catch {
      /* stop is best-effort — dismissing the sheet must never throw */
    }
  }
}
