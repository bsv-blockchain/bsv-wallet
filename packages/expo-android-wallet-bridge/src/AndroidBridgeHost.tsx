/**
 * `<AndroidBridgeHost />` (spec 6.12, 7.2, 7.4, 6.10): the React side of the controller, mounted once in the main tree.
 *
 * - tells the attention logic to re-read the sheet owner on every native lifecycle change (and on `AppState`, which is the
 *   owner while the tracker is unregistered); nothing here decides from `AppState` alone;
 * - tells the session when the host attaches or detaches and when readiness changes (the controller listens too; the
 *   calls are idempotent), so parked connects resume or fail;
 * - mirrors `hostAttached` and readiness to native (`setHostState`) for the trampoline's mode choice;
 * - asks for `POST_NOTIFICATIONS` once, at the first accepted launch, and never again (a denial is final);
 * - asks native to go back to the browser 600 ms after the last pending item cleared (a Kotlin timer: React Native's JS
 *   timers pause while Chrome is in front), and, in the overlay with nothing ever pending, after `IDLE_RETURN_MS`.
 *   Native decides what that means (`ReturnPolicy`): finish the live sheet, or move the wallet task back when the bridge
 *   raised it, or nothing. JS asks only while a window of the wallet is in front (owner is not `'none'`);
 * - mounts `ContextRelayPublisher`, which copies the main tree's contexts to the overlay sheet's second React root;
 * - renders `AndroidBridgeNotices` besides.
 *
 * The notification counts (`setSession`) are published by the session itself on every binding and waiting change, so
 * they follow the ledger without a second writer here.
 */
import React, { useEffect } from 'react'
import { AppState } from 'react-native'
import { getBridgeSnapshot, onSnapshotChange } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { ContextRelayPublisher } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import { AndroidBridgeNotices } from './AndroidBridgeNotices'
import { getAndroidBridge, type AndroidBridge } from './setup'

/** The Kotlin timer that carries the way-back hysteresis. */
export const RETURN_TIMER = 'return-to-browser'
export const RETURN_HYSTERESIS_MS = 600
/** The Kotlin timer of the idle rule: an overlay sheet with nothing ever pending finishes by itself. */
export const IDLE_TIMER = 'idle-return'
/**
 * S3 row (i) failed (a translucent Activity over another app's Activity swallows touches whatever its flags), so an empty
 * sheet cannot be tapped through and this bound is the only protection against a dead end: 5 s, not 20 s.
 */
export const IDLE_RETURN_MS = 5000

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

    // 1. Who shows the sheet. The attention logic re-reads the owner; a change to 'none' is acted on after 500 ms.
    attention.refreshFront()
    const lifeSub = native.addListener('onHostLifecycle', () => attention.refreshFront())
    cleanups.push(() => lifeSub.remove())
    const appState = AppState.addEventListener('change', () => attention.refreshFront())
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

    // 4. Way back to the browser. One rule, two timers.
    //   - after something was pending and nothing is for 600 ms (everPending, as M1);
    //   - the idle rule: the owner is the overlay and nothing has been pending since it came up, for IDLE_RETURN_MS.
    // Both ask whenever the owner is not 'none' (nothing is in front to return from); native decides what it means.
    let everPending = false
    let overlayIdle = false
    const nothingPending = () => attention.waitingCount() === 0 && session.parkedCount() === 0
    const syncIdle = () => {
      const overlay = bridge.owner() === 'overlay'
      if (overlay && !overlayIdle) {
        overlayIdle = true
        if (nothingPending()) native.setTimer(IDLE_TIMER, IDLE_RETURN_MS)
      } else if (!overlay && overlayIdle) {
        overlayIdle = false
        native.clearTimer(IDLE_TIMER)
      }
    }
    syncIdle()
    const idleSub = native.addListener('onHostLifecycle', syncIdle)
    cleanups.push(() => idleSub.remove())
    cleanups.push(
      attention.onWaitingChange(n => {
        if (n > 0) {
          everPending = true
          native.clearTimer(RETURN_TIMER)
          native.clearTimer(IDLE_TIMER)
        } else if (everPending) {
          native.setTimer(RETURN_TIMER, RETURN_HYSTERESIS_MS)
        }
      })
    )
    // A connect that has not raised a prompt yet is already something: it cancels the idle bound too.
    cleanups.push(onSnapshotChange(() => void (!nothingPending() && native.clearTimer(IDLE_TIMER))))
    const timerSub = native.addListener('onTimer', ({ name }) => {
      if (name === IDLE_TIMER) {
        if (bridge.owner() === 'overlay' && nothingPending()) native.returnToBrowser()
        return
      }
      if (name !== RETURN_TIMER) return
      if (!everPending || attention.waitingCount() > 0 || session.parkedCount() > 0) return
      everPending = false
      if (bridge.owner() !== 'none') native.returnToBrowser()
    })
    cleanups.push(() => timerSub.remove())

    return () => {
      native.clearTimer(RETURN_TIMER)
      native.clearTimer(IDLE_TIMER)
      for (const c of cleanups.reverse()) c()
    }
  }, [bridge])

  return (
    <>
      <ContextRelayPublisher />
      <AndroidBridgeNotices bridge={bridge} />
    </>
  )
}
