/**
 * Run a block of token operations against a live key connection, hiding the
 * transport difference:
 *
 * - **session-based native drivers:** callers gather all user input before
 *   entering, then this starts discovery, waits for USB insertion or an NFC
 *   tap, runs every token operation against that selected device, and always
 *   tears discovery down before releasing the process-wide lease. On iOS the
 *   system NFC sheet covers the app; Android listens for USB and NFC together.
 * - **persistent test readers:** the key is already available, so `work` runs
 *   immediately and the reader lifecycle is left untouched.
 *
 * `onWaiting` fires when we begin waiting for the tap, so the UI can prompt
 * "hold your key to the top of your phone". `opts.nfcMessage` is the localised
 * text the iOS scan sheet itself shows; Android accepts and ignores it.
 *
 * This REJECTS instead of waiting forever (spec §3.3 step 2): the system sheet
 * being cancelled → user-cancelled; the session dying with no key → no-key; the
 * key leaving mid-`work` → key-removed-mid-op; and nothing at all arriving by
 * the watchdog deadline → no-key (CoreNFC caps a session at 60 s; YubiKit
 * swallows several failure paths, so no delegate fix makes this redundant).
 */
import { VaultDriver } from './driver'
import { acquireVaultHardwareLease } from './hardwareLease'
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

/**
 * Ceiling on the card work itself, once a key HAS connected.
 *
 * The attach watchdog only guards the wait for a tap. Past that, `work()` was
 * unbounded — and a native call that never settles holds the process-wide
 * hardware lease forever, so every later Vault operation fails `ceremony-active`
 * until the app is restarted. That is not hypothetical: YubiKit's `blockPuk`
 * drops its completion for a status word outside the range it expects, which is
 * why the Swift reset carries its own 30s watchdog.
 *
 * Generous, because real work is slow: a withdrawal signs up to
 * VAULT_INPUTS_PER_TAP digests, each touch-gated with a 15s cache. This is a
 * backstop against a lost completion, not a performance bound.
 */
const DEFAULT_WORK_TIMEOUT_MS = 180_000

export async function withKeySession<T>(
  driver: VaultDriver,
  work: () => Promise<T>,
  onWaiting?: () => void,
  opts?: { nfcMessage?: string; attachTimeoutMs?: number; workTimeoutMs?: number }
): Promise<T> {
  const releaseLease = acquireVaultHardwareLease()
  try {
    if (!driver.sessionBased) return await work()

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
    try {
      onWaiting?.()
      driver.start(opts?.nfcMessage)
      await connected.promise
      clearTimeout(watchdog)
      // Bound the work as well as the wait. `stalled` is only ever a rejection,
      // so a slow-but-live operation is unaffected; what it prevents is a native
      // promise that never settles pinning the lease for the life of the process.
      const stalled = defer<never>()
      stalled.promise.catch(() => {})
      const workWatchdog = setTimeout(
        () => stalled.reject(new VaultError('nfc-lost', 'The YubiKey stopped responding')),
        opts?.workTimeoutMs ?? DEFAULT_WORK_TIMEOUT_MS
      )
      ;(workWatchdog as { unref?: () => void }).unref?.()
      try {
        return await Promise.race([work(), detached.promise, stalled.promise])
      } finally {
        clearTimeout(workWatchdog)
      }
    } finally {
      clearTimeout(watchdog)
      off()
      try {
        driver.stop()
      } catch {
        /* stop is best-effort — dismissing the sheet must never throw */
      }
    }
  } finally {
    // Release only after all native listeners and discovery state are torn
    // down, so a successor cannot be stopped by this operation's finally.
    releaseLease()
  }
}
