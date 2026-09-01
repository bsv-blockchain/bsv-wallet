import { useEffect, useRef, useState } from 'react'
import { getOnline, subscribeOnline } from '@bsv/expo-wallet-toolbox'

/**
 * How long a device must keep reporting offline before the UI says so.
 *
 * Connectivity flaps: NetInfo emits during handovers, on waking, and while a
 * native probe is still settling, and the first of those emissions can arrive
 * before there is anything to report. Announcing each one puts an offline
 * banner in front of someone who has signal — the app claiming a state it has
 * not established. Going back online is not delayed: good news is never in
 * doubt, so it applies on the spot.
 */
export const OFFLINE_CONFIRM_MS = 2500

/**
 * Starts optimistic. A first render that wrongly says "online" costs a failed
 * request; a first render that wrongly says "offline" hides the online payment
 * rails from a user who has signal, which is worse.
 */
export function useOnline(confirmMs: number = OFFLINE_CONFIRM_MS): boolean {
  const [online, setOnline] = useState(true)
  // Held in a ref so a pending confirmation survives re-renders and is cleared
  // the moment connectivity returns.
  const pendingOffline = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearPending = () => {
      if (pendingOffline.current !== null) {
        clearTimeout(pendingOffline.current)
        pendingOffline.current = null
      }
    }

    /** Online applies at once; offline only after it has held for `confirmMs`. */
    const apply = (next: boolean) => {
      if (cancelled) return
      if (next) {
        clearPending()
        setOnline(true)
        return
      }
      if (pendingOffline.current !== null) return
      pendingOffline.current = setTimeout(() => {
        pendingOffline.current = null
        if (!cancelled) setOnline(false)
      }, confirmMs)
    }

    void getOnline()
      .then(apply)
      // A rejected probe is not worth an unhandled rejection at mount. NetInfo
      // reads native state and this hook is mounted by /pay, so a throw here
      // would take the screen down for a device whose connectivity we simply do
      // not know yet — and the optimistic `true` plus `subscribeOnline`'s updates
      // already answer that question well enough.
      .catch(() => {})
    const unsubscribe = subscribeOnline(apply)

    return () => {
      cancelled = true
      clearPending()
      unsubscribe()
    }
  }, [confirmMs])

  return online
}
