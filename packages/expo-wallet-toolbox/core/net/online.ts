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
