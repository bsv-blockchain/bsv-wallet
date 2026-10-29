/**
 * Attention logic (spec 7.4 table). Decides whether a parked consent, prompt or wallet-not-ready state is worth a
 * notification, and keeps the count of bindings that have something pending (a number only: the notification names no
 * site). Native is told a kind and nothing else; the origin never leaves the wallet.
 *
 * | reason                  | wallet in front | action                                                   |
 * | consent, prompt         | yes             | nothing: the in-app sheet is visible                      |
 * | consent, prompt         | no              | post the generic heads-up notification                    |
 * | wallet-not-ready        | any             | nothing right after a launch (the launch raised the wallet), a notification later |
 *
 * "Wallet in front" is the `AppState` signal in M1 (`setMainInFront`, fed by `AndroidBridgeHost`).
 */
import type { Binding } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import type { AttentionReason } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { BsvAndroidBridgeNative } from '../native'

/** A `wallet-not-ready` this soon after a launch was already answered by the launch bringing the wallet forward. */
export const LAUNCH_FRESH_MS = 20_000

export interface Attention {
  requestAttention(reason: AttentionReason, binding: Binding): void
  /** A manager prompt was raised for this binding's originator (fires whether or not the app is active). */
  onPromptRaised(binding: Binding): void
  setMainInFront(front: boolean): void
  isMainInFront(): boolean
  /** A launch was accepted: the wallet was just raised by it. */
  noteLaunch(): void
  /** Whatever was pending for this binding is answered or the binding closed. */
  clear(epoch: string): void
  waitingCount(): number
  onWaitingChange(fn: (n: number) => void): () => void
}

export function createAttention(deps: {
  native: Pick<BsvAndroidBridgeNative, 'postAttention' | 'cancelAttention'>
  clock?: () => number
}): Attention {
  const { native } = deps
  const clock = deps.clock ?? Date.now
  const waiting = new Set<string>()
  const listeners = new Set<(n: number) => void>()
  let front = false
  let launchedAt: number | undefined

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
      if (front) return
      native.postAttention(reason)
    },
    onPromptRaised(binding) {
      // The count only: `requestAttention('prompt')` decides about the notification.
      add(binding.epoch)
    },
    setMainInFront(next) {
      if (next === front) return
      front = next
      // The prompt is on screen now: the heads-up has done its job.
      if (front) native.cancelAttention()
    },
    isMainInFront: () => front,
    noteLaunch() {
      launchedAt = clock()
    },
    clear(epoch) {
      if (!waiting.delete(epoch)) return
      changed()
      if (waiting.size === 0) native.cancelAttention()
    },
    waitingCount: () => waiting.size,
    onWaitingChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    }
  }
}
