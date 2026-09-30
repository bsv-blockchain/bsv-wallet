import type { PushAdapter } from './types'

let initialConsumed = false
/** Test-only. */
export function __resetInitialNotificationForTests(): void {
  initialConsumed = false
}

/** Run `fn`, swallowing a throw: push is an enhancement and must never break its caller. */
function guarded(fn: () => void): void {
  try {
    fn()
  } catch {}
}

/**
 * Subscribe inside its own try/catch. An adapter can throw synchronously when
 * subscribing (the native Firebase app missing on an old dev-client binary);
 * that listener is then simply absent, and the others still attach.
 */
function subscribe(attach: () => () => void): () => void {
  try {
    const off = attach()
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/**
 * Route push events into the existing inbox machinery. A push only ever means
 * "look at the inbox now": the credit, sound and toast come from the normal
 * TaskCreditInbox pass, so nothing is shown or credited twice.
 *
 * Never throws — a broken adapter leaves the wallet exactly as it was without
 * push.
 */
export function attachPushHandlers(args: {
  adapter: PushAdapter
  requestInboxPass: () => void
  openActivity: () => void
  onTokenRefresh: () => void
}): () => void {
  const { adapter, requestInboxPass, openActivity, onTokenRefresh } = args
  const opened = () => {
    guarded(requestInboxPass)
    guarded(openActivity)
  }
  if (!initialConsumed) {
    initialConsumed = true
    try {
      void adapter
        .getInitialNotification()
        .then(e => {
          if (e) opened()
        })
        .catch(() => {})
    } catch {}
  }
  const offs = [
    subscribe(() => adapter.onNotificationOpened(opened)),
    subscribe(() => adapter.onForegroundMessage(() => guarded(requestInboxPass))),
    subscribe(() => adapter.onTokenRefresh(() => guarded(onTokenRefresh)))
  ]
  return () => offs.forEach(off => guarded(off))
}

/**
 * Serialize an async job that several triggers can fire at once (startup,
 * token refresh, return to foreground). Never two runs at the same time; calls
 * that land while one is in flight are folded into a single rerun after it
 * finishes, not one rerun each. The returned promise settles once the work it
 * asked for has run, and never rejects.
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
            await run()
          } catch {}
        } while (rerun)
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }
}
