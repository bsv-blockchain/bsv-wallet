import type { PushAdapter, PushOpenedEvent } from './types'

let initialConsumed = false
/** Test-only. */
export function __resetInitialNotificationForTests(): void {
  initialConsumed = false
}

/**
 * Push failures are contained, never thrown, but they are not silent: a
 * swallowed failure with no trace is how "push never works on this build"
 * becomes impossible to diagnose. Only the error message is logged — never the
 * push payload, the FCM token or an identity key.
 */
function warn(what: string, e: unknown): void {
  console.warn(`[push] ${what} failed: ${e instanceof Error ? e.message : String(e)}`)
}

/** Run `fn`, containing a throw: push is an enhancement and must never break its caller. */
function guarded(what: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    warn(what, e)
  }
}

/**
 * Subscribe inside its own try/catch. An adapter can throw synchronously when
 * subscribing (the native Firebase app missing on an old dev-client binary);
 * that listener is then simply absent, and the others still attach.
 */
function subscribe(what: string, attach: () => () => void): () => void {
  try {
    const off = attach()
    return typeof off === 'function' ? off : () => {}
  } catch (e) {
    warn(`${what} subscribe`, e)
    return () => {}
  }
}

/**
 * Route push events into the existing inbox machinery. A push only ever means
 * "look at the inbox now": the credit, sound and toast come from the normal
 * TaskCreditInbox pass, so nothing is shown or credited twice.
 *
 * Every profile of the wallet registers this device, so a push can be for a
 * profile that is not the open one. The server says which in `data.recipient`
 * (the recipient's identity key) and `resolveInactiveProfile` maps it to a live
 * profile that is not open. Only that positive match changes anything:
 *   - a tap switches to that profile first, then does what a tap always did;
 *   - a foreground message does not run the open profile's inbox pass, which
 *     would read a different MessageBox and credit nothing.
 * A push with no recipient (a server from before it was sent), for the open
 * profile, or for an identity this device does not know behaves exactly as it
 * did before profiles had their own pushes.
 *
 * Never throws — a broken adapter leaves the wallet exactly as it was without
 * push.
 */
export function attachPushHandlers(args: {
  adapter: PushAdapter
  requestInboxPass: () => void
  openActivity: () => void
  onTokenRefresh: () => void
  /** The index of the live, non-open profile whose identity key is `recipient`; undefined for anything else. */
  resolveInactiveProfile?: (recipient: string) => number | undefined
  /** Make profile `index` the open one. Resolves true once it is; false (or a throw) when it could not be. */
  switchProfile?: (index: number) => Promise<boolean>
}): () => void {
  const { adapter, requestInboxPass, openActivity, onTokenRefresh, resolveInactiveProfile, switchProfile } = args

  const inactiveProfileOf = (e: PushOpenedEvent | undefined | null): number | undefined => {
    const recipient = e?.data?.recipient
    if (!resolveInactiveProfile || typeof recipient !== 'string' || recipient === '') return undefined
    try {
      return resolveInactiveProfile(recipient)
    } catch (err) {
      warn('resolveInactiveProfile', err)
      return undefined
    }
  }

  const openOpenProfile = () => {
    guarded('requestInboxPass', requestInboxPass)
    guarded('openActivity', openActivity)
  }
  const switchThenOpen = async (index: number) => {
    let landed = false
    try {
      landed = (await switchProfile?.(index)) === true
    } catch (err) {
      warn('switchProfile', err)
    }
    // A switch that did not land leaves the user on the profile they were on,
    // whose Activity has nothing to do with this push.
    if (landed) openOpenProfile()
  }
  const opened = (e?: PushOpenedEvent | null) => {
    const index = inactiveProfileOf(e)
    if (index === undefined || !switchProfile) return openOpenProfile()
    void switchThenOpen(index)
  }

  if (!initialConsumed) {
    initialConsumed = true
    try {
      void adapter
        .getInitialNotification()
        .then(e => {
          if (e) opened(e)
        })
        .catch(e => warn('getInitialNotification', e))
    } catch (e) {
      warn('getInitialNotification', e)
    }
  }
  const offs = [
    subscribe('onNotificationOpened', () => adapter.onNotificationOpened(opened)),
    subscribe('onForegroundMessage', () =>
      adapter.onForegroundMessage(e => {
        if (inactiveProfileOf(e) !== undefined) return
        guarded('requestInboxPass', requestInboxPass)
      })
    ),
    subscribe('onTokenRefresh', () => adapter.onTokenRefresh(() => guarded('onTokenRefresh', onTokenRefresh)))
  ]
  return () => offs.forEach(off => guarded('unsubscribe', off))
}

/**
 * How long one registration sync may run before it is given up on. React
 * Native's Android fetch has no default timeout, so a stalled connection would
 * otherwise hold the lock below until the next wallet build.
 */
export const PUSH_SYNC_TIMEOUT_MS = 30_000

/**
 * Race one run against PUSH_SYNC_TIMEOUT_MS. The run itself cannot be cancelled,
 * so on a timeout it is simply abandoned: whatever it settles with later (its
 * rejection included) is handled by the race and ignored.
 */
async function runWithTimeout(run: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), PUSH_SYNC_TIMEOUT_MS)
  })
  try {
    await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Serialize an async job that several triggers can fire at once (startup,
 * token refresh, return to foreground). Never two runs at the same time; calls
 * that land while one is in flight are folded into a single rerun after it
 * finishes, not one rerun each. A run that does not finish within
 * PUSH_SYNC_TIMEOUT_MS is logged and let go, so a hung request cannot block
 * every later sync. The returned promise settles once the work it asked for
 * has run, and never rejects.
 */
export function coalesceRuns(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  let rerun = false
  return () => {
    if (inFlight) {
      rerun = true
      return inFlight
    }
    inFlight = (async () => {
      try {
        do {
          rerun = false
          try {
            await runWithTimeout(run)
          } catch (e) {
            warn('registration sync', e)
          }
        } while (rerun)
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }
}
