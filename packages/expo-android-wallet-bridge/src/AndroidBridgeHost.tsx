/**
 * `<AndroidBridgeHost />` (spec 6.12, 7.2, 7.4, 6.10): the React side of the controller, mounted once in the main tree.
 *
 * - feeds the main-in-front signal (`AppState`) to the attention logic;
 * - tells the session when the host attaches or detaches and when readiness changes (the controller listens too; the
 *   calls are idempotent), so parked connects resume or fail;
 * - mirrors `hostAttached` and readiness to native (`setHostState`) for the trampoline's mode choice;
 * - asks for `POST_NOTIFICATIONS` once, at the first accepted launch, and never again (a denial is final);
 * - asks native to go back to the browser 600 ms after the last pending item cleared (a Kotlin timer: React Native's JS
 *   timers pause while Chrome is in front). Native performs it only when the bridge raised the wallet (Task 13).
 *   Nothing is requested when nothing was ever pending;
 * - renders `AndroidBridgeNotices` and nothing else.
 *
 * The notification counts (`setSession`) are published by the session itself on every binding and waiting change, so
 * they follow the ledger without a second writer here.
 */
import React, { useEffect } from 'react'
import { AppState } from 'react-native'
import { getBridgeSnapshot, onSnapshotChange } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { AndroidBridgeNotices } from './AndroidBridgeNotices'
import { getAndroidBridge, type AndroidBridge } from './setup'

/** The Kotlin timer that carries the way-back hysteresis. */
export const RETURN_TIMER = 'return-to-browser'
export const RETURN_HYSTERESIS_MS = 600

export interface AndroidBridgeHostProps {
  /** Defaults to the bridge `setupAndroidBridge` created; tests inject one. */
  bridge?: AndroidBridge
}

export function AndroidBridgeHost({ bridge: given }: AndroidBridgeHostProps): React.ReactElement | null {
  const bridge = given ?? getAndroidBridge()

  useEffect(() => {
    if (!bridge) return
    const { native, attention, session, notices } = bridge
    const cleanups: Array<() => void> = []

    // 1. Wallet in front.
    attention.setMainInFront(AppState.currentState === 'active')
    const appState = AppState.addEventListener('change', state => attention.setMainInFront(state === 'active'))
    cleanups.push(() => appState?.remove?.())

    // 2. Host attach and readiness.
    session.onHostAttached(getBridgeSnapshot().hostAttached)
    cleanups.push(onSnapshotChange(s => session.onHostAttached(s.hostAttached)))

    // 2b. Mirror host state to native, so the trampoline chooses overlay mode only when the host is attached and ready.
    const mirror = (s: { hostAttached: boolean; readiness: string }) =>
      native.setHostState({ attached: s.hostAttached, ready: s.readiness === 'ready' })
    mirror(getBridgeSnapshot())
    cleanups.push(onSnapshotChange(mirror))
    cleanups.push(() => native.setHostState({ attached: false, ready: false }))

    // 3. Notification permission, once, at the first accepted launch (also one that arrived before this mounted).
    const askPermission = () => {
      if (notices.launchCount() === 0 || native.notificationPermission() !== 'undetermined') return
      if (!notices.claimPermissionRequest()) return
      void native.requestNotificationPermission().catch(() => undefined)
    }
    askPermission()
    cleanups.push(notices.onLaunchAccepted(askPermission))

    // 4. Way back to the browser.
    let everPending = false
    cleanups.push(
      attention.onWaitingChange(n => {
        if (n > 0) {
          everPending = true
          native.clearTimer(RETURN_TIMER)
        } else if (everPending) {
          native.setTimer(RETURN_TIMER, RETURN_HYSTERESIS_MS)
        }
      })
    )
    const timerSub = native.addListener('onTimer', ({ name }) => {
      if (name !== RETURN_TIMER) return
      if (!everPending || attention.waitingCount() > 0 || session.parkedCount() > 0) return
      everPending = false
      native.returnToBrowser()
    })
    cleanups.push(() => timerSub.remove())

    return () => {
      native.clearTimer(RETURN_TIMER)
      for (const c of cleanups.reverse()) c()
      attention.setMainInFront(false)
    }
  }, [bridge])

  return <AndroidBridgeNotices bridge={bridge} />
}
