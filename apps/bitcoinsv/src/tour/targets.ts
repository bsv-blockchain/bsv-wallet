// What the Home tour points at (the prototype's data-tour attributes): each
// element registers its view under a name, and the tour measures them on
// screen when it shows a step.
import type { View } from 'react-native'

export type TourTarget = 'wallets' | 'signin' | 'search' | 'help' | 'settings' | 'actions' | 'activity' | 'contacts'

const targets = new Map<TourTarget, View>()
const refs = new Map<TourTarget, (el: View | null) => void>()

/** A stable ref callback that registers the element under `name`. */
export function tourTarget(name: TourTarget) {
  let ref = refs.get(name)
  if (!ref) {
    ref = (el: View | null) => {
      if (el) targets.set(name, el)
      else targets.delete(name)
    }
    refs.set(name, ref)
  }
  return ref
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where `name` is on screen now, or null when it isn't there. */
export function measureTarget(name: TourTarget): Promise<Rect | null> {
  const el = targets.get(name)
  if (!el) return Promise.resolve(null)
  return new Promise(resolve =>
    el.measureInWindow((x, y, width, height) => resolve(width > 0 && height > 0 ? { x, y, width, height } : null))
  )
}
