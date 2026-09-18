/**
 * The single definition of "online" for the whole app.
 *
 * BOTH fields are tri-state: NetInfo reports `null` for each while it has not
 * finished probing, and at cold start `isConnected` is routinely `null` for a
 * beat. Only an explicit `false` counts against us — anything else is "not
 * known yet", which must not read as offline.
 *
 * Requiring `isConnected === true` here (the old rule) is what put the offline
 * banner on the home screen of phones that were online the whole time: the
 * first NetInfo emission arrives before the native probe has an answer, so the
 * app announced a state it had not established. Unknown is optimistic for the
 * same reason it is everywhere else in this codebase — a wrong "online" costs a
 * retry, a wrong "offline" hides the online rails from someone who has signal.
 */
import NetInfo from '@react-native-community/netinfo'
import { DEFAULT_MESSAGEBOX_URL } from '../config'
import { DEFAULT_ARC_URLS } from '../constants'

export interface OnlineState {
  isConnected: boolean | null
  isInternetReachable: boolean | null
}

export function isOnlineState(state: OnlineState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false
}

export async function getOnline(): Promise<boolean> {
  return isOnlineState(await NetInfo.fetch())
}

/** Returns the unsubscribe function. */
export function subscribeOnline(cb: (online: boolean) => void): () => void {
  return NetInfo.addEventListener(state => cb(isOnlineState(state)))
}

/** Longest a live request may take before it counts as "nothing got out". */
export const PROBE_TIMEOUT_MS = 4000

/**
 * Hosts the wallet already talks to, so asking them adds no third party and no
 * new traffic pattern. HTTPS, so a captive portal cannot answer for them.
 */
const PROBE_URLS = [DEFAULT_ARC_URLS.main, DEFAULT_MESSAGEBOX_URL]

/**
 * A live request, for when NetInfo's verdict is offline and something needs to
 * know whether to believe it.
 *
 * That verdict is not a measurement of the moment. On iOS it is a cached
 * reachability snapshot — the OS delivers no callbacks while the app is
 * suspended, and NetInfo's cache is never re-read — plus an HTTP probe of a
 * Google host the wallet has no other use for. Either can say offline for a
 * device whose connection works, and NetInfo will not correct itself until the
 * next network change. This asks the wallet's own hosts instead: any HTTP
 * response, a 404 included, proves DNS, a route and TLS all worked, so one
 * answer from any host is enough. It only ever upgrades a verdict to online,
 * never the reverse.
 */
export function probeOnline(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const controller = new AbortController()
    let failed = 0
    const finish = (online: boolean) => {
      clearTimeout(timer)
      controller.abort()
      resolve(online)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    for (const url of PROBE_URLS) {
      Promise.resolve()
        .then(() => fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: controller.signal }))
        .then(
          () => finish(true),
          () => {
            failed += 1
            if (failed === PROBE_URLS.length) finish(false)
          }
        )
    }
  })
}
