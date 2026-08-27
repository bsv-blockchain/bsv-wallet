/**
 * Semantic haptic vocabulary (spec Part 1). Import `haptics` directly in
 * plain modules; use `useHaptics()` in components for symmetry with other
 * hooks. All calls are fire-and-forget and never throw.
 *
 * | semantic | iOS                         | Android |
 * |----------|-----------------------------|---------|
 * | tap      | selectionAsync              | no-op   |
 * | confirm  | impactAsync(Light)          | no-op   |
 * | success  | notificationAsync(Success)  | vibrate |
 * | warning  | notificationAsync(Warning)  | vibrate |
 * | error    | notificationAsync(Error)    | vibrate |
 *
 * expo-haptics is required lazily, on first call, rather than imported
 * statically — this file is barrel-exported from the package root, and a
 * static top-level `import` of a native module gets eagerly evaluated for
 * every consumer of the barrel (breaking non-native/test hosts that never
 * call a haptic), the same class of issue documented on
 * services/vault/driver.ts and random.ts's lazy native requires.
 */
import { Platform } from 'react-native'

type HapticsModule = typeof import('expo-haptics')

let mod: HapticsModule | null | undefined

function load(): HapticsModule | null {
  if (mod !== undefined) return mod
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule
  } catch {
    mod = null
  }
  return mod
}

const swallow = (p: Promise<void>) => { p.catch(() => {}) }
const isIOS = () => Platform.OS === 'ios'

export const haptics = {
  tap: () => { const h = load(); if (h && isIOS()) swallow(h.selectionAsync()) },
  confirm: () => { const h = load(); if (h && isIOS()) swallow(h.impactAsync(h.ImpactFeedbackStyle.Light)) },
  success: () => { const h = load(); if (h) swallow(h.notificationAsync(h.NotificationFeedbackType.Success)) },
  warning: () => { const h = load(); if (h) swallow(h.notificationAsync(h.NotificationFeedbackType.Warning)) },
  error: () => { const h = load(); if (h) swallow(h.notificationAsync(h.NotificationFeedbackType.Error)) },
} as const

export type HapticName = keyof typeof haptics

export const useHaptics = () => haptics
