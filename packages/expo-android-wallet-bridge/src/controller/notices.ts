/**
 * Host-facing signals (spec 6.10, 6.12, 7.2): the three notices the wallet shows while a page is trying to use it, and
 * the "a launch was accepted" count that triggers the one-time notification permission request.
 *
 * Everything here is a flag or a number. No origin, epoch or secret is ever stored, so the notices can be rendered
 * anywhere in the app. The session and the controller write; `AndroidBridgeHost` and `AndroidBridgeNotices` read.
 */

/** `ports-exhausted`: every port of the range was taken (`ERR_PORTS_EXHAUSTED`); `not-ready`: attached with no wallet (503). */
export type NoticeKind = 'ports-exhausted' | 'not-ready'

export interface NoticeSink {
  raise(kind: NoticeKind): void
  clear(kind: NoticeKind): void
}

export interface Notices extends NoticeSink {
  active(kind: NoticeKind): boolean
  /** Fires after any change of the flags. */
  subscribe(fn: () => void): () => void
  /** A launch URI was parsed and stored (called by the controller). */
  noteLaunchAccepted(): void
  launchCount(): number
  /** Fires once per accepted launch. */
  onLaunchAccepted(fn: () => void): () => void
  /** True exactly once per bridge: the caller owns the notification permission request. */
  claimPermissionRequest(): boolean
}

export function createNotices(): Notices {
  const flags = new Set<NoticeKind>()
  const listeners = new Set<() => void>()
  const launchListeners = new Set<() => void>()
  let launches = 0
  let asked = false

  const changed = () => {
    for (const fn of Array.from(listeners)) fn()
  }

  return {
    raise(kind) {
      if (flags.has(kind)) return
      flags.add(kind)
      changed()
    },
    clear(kind) {
      if (!flags.delete(kind)) return
      changed()
    },
    active: kind => flags.has(kind),
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    noteLaunchAccepted() {
      launches++
      for (const fn of Array.from(launchListeners)) fn()
    },
    launchCount: () => launches,
    onLaunchAccepted(fn) {
      launchListeners.add(fn)
      return () => void launchListeners.delete(fn)
    },
    claimPermissionRequest() {
      if (asked) return false
      asked = true
      return true
    }
  }
}
