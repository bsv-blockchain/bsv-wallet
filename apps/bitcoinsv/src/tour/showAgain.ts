// "Where's the tour again?" (the prototype's useShowTourAgain): closing the
// tour video walks you to it. Settings, with "Take the tour" lit up; then
// back to Home, where the Settings button it's under glows for a moment.
import { useSyncExternalStore } from 'react'

type State = { tourRow: boolean; settingsButton: boolean }
let state: State = { tourRow: false, settingsButton: false }
const listeners = new Set<() => void>()

export function setShowAgain(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}

export function useShowAgain(): State {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}
