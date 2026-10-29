/**
 * Which window shows the permission sheet (spec 7.4, "one owner at a time"). `'overlay'` iff the sheet Activity is
 * resumed and `MainActivity` is not; `'main'` iff `MainActivity` is resumed; `'none'` otherwise (briefly, at every
 * handover, no Activity is resumed). Every attention decision and the foreground-mode `returnToBrowser` gate read this,
 * never `AppState`, with one exception: while the native tracker has not caught up (`registered` false, about 1.8 s
 * after a cold start) the answer falls back to `AppState`, so M1 foreground mode keeps its semantics.
 *
 * Handover order. `AppState` flips `background` then `active` about 50 ms apart at each handover and the owner is
 * `'none'` in between; the two roots subscribe to the same store in an order this code cannot control. The deciding
 * hooks (`useSheetOwnerDeferred`) make the giving-up side unmount at once and the taking-over side mount one tick later,
 * so two `PermissionSheet` instances never exist at once, whichever subscriber is notified first.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import type { BsvAndroidBridgeNative, HostLifecycle } from '../native'

export type SheetOwner = 'main' | 'overlay' | 'none'
export type OwnerSource = Pick<BsvAndroidBridgeNative, 'hostLifecycle' | 'addListener'>

let source: OwnerSource | undefined
const listeners = new Set<() => void>()
let detach: (() => void) | undefined

/** The pure rule. `registered` is checked by the caller. */
export function ownerOf(l: Pick<HostLifecycle, 'mainResumed' | 'sheetResumed'>): SheetOwner {
  if (l.mainResumed) return 'main'
  if (l.sheetResumed) return 'overlay'
  return 'none'
}

export function sheetOwner(): SheetOwner {
  const l = source?.hostLifecycle()
  if (!l || !l.registered) return AppState.currentState === 'active' ? 'main' : 'none'
  return ownerOf(l)
}

const emit = () => {
  for (const fn of [...listeners]) fn()
}

function attach() {
  detach?.()
  detach = undefined
  if (listeners.size === 0) return
  const subs: Array<{ remove(): void } | undefined> = []
  if (source) subs.push(source.addListener('onHostLifecycle', emit))
  // Unregistered, the owner is `AppState`'s answer, so its changes are changes of the owner too.
  subs.push(AppState.addEventListener('change', emit))
  detach = () => subs.forEach(s => s?.remove?.())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  if (listeners.size === 1) attach()
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      detach?.()
      detach = undefined
    }
  }
}

/** Points the owner at the native tracker (`setupAndroidBridge` does this; tests pass a fake). */
export function setSheetOwnerSource(native: OwnerSource | undefined): void {
  source = native
  attach()
  emit()
}

export function useSheetOwner(): SheetOwner {
  return useSyncExternalStore(subscribe, sheetOwner, sheetOwner)
}

/**
 * Whether `side` may render the sheet, with the ordered handover. `holdsNow` is the raw answer for the side (the gate:
 * owner is not `'overlay'`; the root: owner is `'overlay'`). Losing it takes effect in the same render; gaining it takes
 * effect one tick later. A first render that already holds it mounts at once (there is no other side to wait for).
 */
function useDeferredHold(holdsNow: boolean): boolean {
  const [settled, setSettled] = useState(holdsNow)
  useEffect(() => {
    if (!holdsNow) {
      setSettled(false)
      return
    }
    const id = setTimeout(() => setSettled(true), 0)
    return () => clearTimeout(id)
  }, [holdsNow])
  return holdsNow && settled
}

export function useSheetOwnerDeferred(side: 'main' | 'overlay'): boolean {
  const owner = useSheetOwner()
  return useDeferredHold(side === 'overlay' ? owner === 'overlay' : owner !== 'overlay')
}
