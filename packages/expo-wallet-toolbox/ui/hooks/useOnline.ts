import { useEffect, useState } from 'react'
import { getOnline, probeOnline, subscribeOnline } from '@bsv/expo-wallet-toolbox'

/**
 * How long a device must keep reporting offline before the UI even asks whether
 * it is.
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
 * How often an offline claim is put to the network again while it stands.
 *
 * NetInfo will not emit again for a snapshot that is merely out of date, so
 * left to NetInfo alone a wrong banner would stay until the next network
 * change. This is what lets it clear itself.
 */
export const OFFLINE_RECHECK_MS = 15_000

/**
 * Starts optimistic. A first render that wrongly says "online" costs a failed
 * request; a first render that wrongly says "offline" hides the online payment
 * rails from a user who has signal, which is worse.
 *
 * NetInfo's offline verdict is a claim, not a fact. On iOS it is a cached
 * reachability snapshot (the OS sends no callbacks while the app is suspended)
 * plus an HTTP probe of a Google host, and either can read offline for a phone
 * whose connection works. So once a report has held for `confirmMs`, a real
 * request to the wallet's own hosts decides: only if that also fails does the
 * UI say offline, and while it does the request is repeated every `recheckMs`.
 */
export function useOnline(confirmMs: number = OFFLINE_CONFIRM_MS, recheckMs: number = OFFLINE_RECHECK_MS): boolean {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    let cancelled = false
    /** NetInfo's latest verdict is offline: the claim being put to the network. */
    let claimedOffline = false
    let warned = false
    let checking = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const schedule = (ms: number) => {
      timer = setTimeout(() => {
        timer = null
        void verify()
      }, ms)
    }

    /** Asks the network. Repeats for as long as NetInfo keeps insisting on offline. */
    const verify = async () => {
      checking = true
      let reached = false
      try {
        reached = (await probeOnline()) === true
      } catch {
        // A probe that cannot even run is an offline answer, not a crash.
      }
      checking = false
      // Superseded while the request was out: connectivity came back, or unmounted.
      if (cancelled || !claimedOffline) return
      if (reached && !warned) {
        warned = true
        console.warn('[net] NetInfo reports offline but a live request got through; treating as online')
      }
      setOnline(reached)
      schedule(recheckMs)
    }

    const apply = (next: boolean) => {
      if (cancelled) return
      claimedOffline = !next
      if (next) {
        clearTimer()
        warned = false
        setOnline(true)
        return
      }
      // Already waiting out the window, or mid-request: that pass covers this report.
      if (timer !== null || checking) return
      schedule(confirmMs)
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
      clearTimer()
      unsubscribe()
    }
  }, [confirmMs, recheckMs])

  return online
}
