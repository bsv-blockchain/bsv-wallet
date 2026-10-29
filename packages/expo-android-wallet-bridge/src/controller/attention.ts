/**
 * Attention logic (spec 7.4 table). Decides whether a parked consent, prompt or wallet-not-ready state is worth a
 * notification, and keeps the count of bindings that have something pending (a number only: the notification names no
 * site). Native is told a kind and nothing else; the origin never leaves the wallet.
 *
 * | reason                  | owner            | action                                                              |
 * | consent, prompt         | main or overlay  | nothing: the sheet is visible (in the wallet, or in the overlay)     |
 * | consent, prompt         | none             | `showSheet(reason)` then the generic heads-up, always both            |
 * | wallet-not-ready        | any              | nothing right after a launch (the launch raised the wallet), a notification later |
 *
 * "Owner" is `sheetOwner()` (the native lifecycle tracker; `AppState` only while the tracker is unregistered), never
 * `AppState` alone. At every Main-to-sheet or sheet-to-Main handover no Activity is resumed for about 50 ms, so a change
 * to `'none'` is acted on only after `OWNER_NONE_MS`, re-reading the owner then. The wait is a native timer, because a
 * JS timer does not fire while the app is stopped, which is exactly the Home-with-a-pending-prompt case.
 */
import type { Binding } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import type { AttentionReason } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { AttentionKind, BsvAndroidBridgeNative } from '../native'
import type { SheetOwner } from '../ui/sheetOwner'

/** A `wallet-not-ready` this soon after a launch was already answered by the launch bringing the wallet forward. */
export const LAUNCH_FRESH_MS = 20_000

/** How long the owner must stay `'none'` before a pending prompt is worth a heads-up (the handover blip is about 50 ms). */
export const OWNER_NONE_MS = 500
/** The Kotlin timer carrying that wait. */
export const OWNER_NONE_TIMER = 'owner-none'

export interface Attention {
  requestAttention(reason: AttentionReason, binding: Binding): void
  /** A manager prompt was raised for this binding's originator (fires whether or not the app is active). */
  onPromptRaised(binding: Binding): void
  /** Re-reads the owner (the host calls this on every lifecycle change): acts at once for main or overlay, after 500 ms for none. */
  refreshFront(): void
  /** True while a window of the wallet (main or overlay) shows the sheet. */
  isWalletInFront(): boolean
  /** A launch was accepted: the wallet was just raised by it. */
  noteLaunch(): void
  /** Whatever was pending for this binding is answered or the binding closed. */
  clear(epoch: string): void
  waitingCount(): number
  onWaitingChange(fn: (n: number) => void): () => void
}

export function createAttention(deps: {
  native: Pick<
    BsvAndroidBridgeNative,
    'postAttention' | 'cancelAttention' | 'showSheet' | 'setTimer' | 'clearTimer' | 'addListener'
  >
  owner: () => SheetOwner
  clock?: () => number
}): Attention {
  const { native } = deps
  const clock = deps.clock ?? Date.now
  const waiting = new Set<string>()
  const listeners = new Set<(n: number) => void>()
  let launchedAt: number | undefined
  /** The owner last seen, and when it became `'none'` (undefined when it never changed to none since creation). */
  let lastOwner: SheetOwner = deps.owner()
  let noneSince: number | undefined
  /** The reason of the latest consent or prompt that found nobody in front, waiting for the 500 ms to pass. */
  let deferred: AttentionKind | undefined
  let timerArmed = false
  /** The kind of the latest consent or prompt still pending, so a later change to `'none'` knows what to announce. */
  let lastPendingReason: AttentionKind | undefined

  const inFront = () => deps.owner() !== 'none'

  const disarm = () => {
    deferred = undefined
    if (timerArmed) {
      timerArmed = false
      native.clearTimer(OWNER_NONE_TIMER)
    }
  }
  const notify = (reason: AttentionKind) => {
    native.showSheet(reason as 'consent' | 'prompt')
    native.postAttention(reason)
  }
  /** Reads the owner and keeps `lastOwner` and `noneSince` current. Returns it. */
  const sync = (): SheetOwner => {
    const o = deps.owner()
    if (o !== lastOwner) {
      if (o === 'none') {
        noneSince = clock()
        // Home or Back with a prompt still pending: the heads-up follows after the wait, if nobody came back by then.
        if (waiting.size > 0 && lastPendingReason !== undefined) {
          deferred = lastPendingReason
          arm(OWNER_NONE_MS)
        }
      } else {
        noneSince = undefined
        // The prompt is on screen now: the heads-up has done its job, and a wait for it is moot.
        disarm()
        native.cancelAttention()
      }
      lastOwner = o
    }
    return o
  }
  /** Milliseconds still to wait before acting on owner `'none'` (0: act now). */
  const remaining = () => (noneSince === undefined ? 0 : Math.max(0, OWNER_NONE_MS - (clock() - noneSince)))
  const arm = (ms: number) => {
    if (timerArmed) return
    timerArmed = true
    native.setTimer(OWNER_NONE_TIMER, Math.max(1, ms))
  }

  native.addListener('onTimer', ({ name }) => {
    if (name !== OWNER_NONE_TIMER) return
    timerArmed = false
    const reason = deferred
    deferred = undefined
    if (!reason) return
    if (sync() !== 'none' || waiting.size === 0) return
    const left = remaining()
    if (left > 0) {
      deferred = reason
      arm(left)
      return
    }
    notify(reason)
  })

  const changed = () => {
    for (const fn of Array.from(listeners)) fn(waiting.size)
  }
  const add = (epoch: string) => {
    if (waiting.has(epoch)) return
    waiting.add(epoch)
    changed()
  }

  return {
    requestAttention(reason, binding) {
      add(binding.epoch)
      if (reason === 'wallet-not-ready') {
        if (launchedAt !== undefined && clock() - launchedAt < LAUNCH_FRESH_MS) return
        native.postAttention('wallet-not-ready')
        return
      }
      lastPendingReason = reason
      if (sync() !== 'none') return
      const left = remaining()
      if (left > 0) {
        // The handover blip: nobody is resumed for a moment. Look again when it has had time to end.
        deferred = reason
        arm(left)
        return
      }
      notify(reason)
    },
    onPromptRaised(binding) {
      // The count only: `requestAttention('prompt')` decides about the notification.
      add(binding.epoch)
    },
    refreshFront() {
      sync()
    },
    isWalletInFront: inFront,
    noteLaunch() {
      launchedAt = clock()
    },
    clear(epoch) {
      if (!waiting.delete(epoch)) return
      changed()
      if (waiting.size === 0) {
        lastPendingReason = undefined
        disarm()
        native.cancelAttention()
      }
    },
    waitingCount: () => waiting.size,
    onWaitingChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    }
  }
}
