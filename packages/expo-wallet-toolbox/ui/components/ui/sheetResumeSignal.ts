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
