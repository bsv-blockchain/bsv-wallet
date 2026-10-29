/**
 * A host-neutral nudge for `Sheet`. The Android browser bridge shows permission sheets on a second React root inside a
 * translucent Activity; when that Activity resumes, `AppState` may already have gone `active` before the root's sheet
 * mounted, so `Sheet`'s own `AppState` re-apply never fires and the scrim can show without the sheet (SPIKES Task 22).
 * The bridge calls `signalSheetResumed()` when its sheet Activity resumes and every open `Sheet` re-applies its open
 * position. The toolbox does not depend on the bridge: this is the whole seam.
 */
const listeners = new Set<() => void>()

export function onSheetResumed(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function signalSheetResumed(): void {
  for (const fn of [...listeners]) fn()
}

/**
 * Whether a tap on the sheet's backdrop (or a swipe down) answers the prompt as a rejection. True in the app. The Android
 * bridge's overlay root turns it off: there an outside tap does nothing, and leaving never answers (BRC-219); only the
 * Reject button rejects.
 */
let backdropDismisses = true
const dismissListeners = new Set<() => void>()

export function setSheetBackdropDismisses(value: boolean): void {
  if (backdropDismisses === value) return
  backdropDismisses = value
  for (const fn of [...dismissListeners]) fn()
}
export function getSheetBackdropDismisses(): boolean {
  return backdropDismisses
}
export function onSheetBackdropDismissesChange(fn: () => void): () => void {
  dismissListeners.add(fn)
  return () => void dismissListeners.delete(fn)
}
