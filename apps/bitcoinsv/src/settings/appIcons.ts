// The app icons to choose from (the prototype's components/brand/app-icons.tsx):
// the Bitcoin SV mark (the default icon), the Bitcoin SV dragon, Bitcoin's
// original "BC" coin and Satoshi's ₿ coin. The real home-screen icon changes
// through expo-alternate-app-icons (iOS alternate icons, Android activity
// aliases; app.config.js names them).
//
// Android closes the app when the alias it was opened from is switched off,
// so there the change waits until the app goes to the background. In a
// development build it stays in the app (the marks follow it, the home-screen
// icon doesn't): the dev launcher starts MainActivity by name, and can't once
// another icon has switched it off.
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

type IconsModule = typeof import('expo-alternate-app-icons')

/** Loaded on first use: a build without the native module (an older dev client) still runs. */
let mod: IconsModule | null | undefined
function icons(): IconsModule | null {
  if (mod !== undefined) return mod
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-alternate-app-icons') as IconsModule
  } catch {
    mod = null
  }
  return mod
}

export type AppIconId = 'classic' | 'dragon' | 'original' | 'satoshi'

export const APP_ICONS: { id: AppIconId; name: string; native: string | null }[] = [
  { id: 'classic', name: 'Bitcoin SV', native: null },
  { id: 'dragon', name: 'Dragon', native: 'Dragon' },
  { id: 'original', name: 'Original', native: 'Original' },
  { id: 'satoshi', name: 'Satoshi', native: 'Satoshi' }
]

/** The coin each icon shows, cut out round (the Bitcoin SV mark is drawn). */
export const COIN_IMAGES: Record<Exclude<AppIconId, 'classic'>, number> = {
  dragon: require('../../assets/images/app-icons/dragon-coin.png'),
  original: require('../../assets/images/app-icons/original-coin.png'),
  satoshi: require('../../assets/images/app-icons/satoshi-coin.png')
}

/** Android's choice, waiting for the app to leave the screen. */
let pending: AppIconId | null = null
let waiting: { remove(): void } | null = null

/** The whole icon, as the home screen shows it (Settings' About). */
export const ICON_IMAGES: Record<AppIconId, number> = {
  classic: require('../../assets/images/icon.png'),
  dragon: require('../../assets/images/app-icons/dragon.png'),
  original: require('../../assets/images/app-icons/original.png'),
  satoshi: require('../../assets/images/app-icons/satoshi.png')
}

/** The chosen icon, for the app's own BSV mark (src/ui/BsvMark.tsx) to follow. */
let chosen: AppIconId | null = null
const listeners = new Set<() => void>()
function choose(id: AppIconId) {
  chosen = id
  listeners.forEach(l => l())
}

export function useAppIcon(): AppIconId {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (chosen ??= currentAppIcon())
  )
}

/** The icon the phone has now (or will, on Android, once you leave the app). */
export function currentAppIcon(): AppIconId {
  if (pending) return pending
  try {
    const name = icons()?.getAppIconName() ?? null
    return APP_ICONS.find(i => i.native === name)?.id ?? 'classic'
  } catch {
    return 'classic'
  }
}

export const canChangeAppIcon = (): boolean => {
  try {
    return !!icons()?.supportsAlternateIcons
  } catch {
    return false
  }
}

/** Sets the phone's icon: at once on iOS (which says so itself), on Android when the app goes to the background. */
export async function applyAppIcon(id: AppIconId): Promise<void> {
  const m = icons()
  if (!m) throw new Error('This build can’t change its icon')
  const native = (i: AppIconId) => APP_ICONS.find(x => x.id === i)?.native ?? null
  if (Platform.OS !== 'android') {
    await m.setAlternateAppIcon(native(id))
    choose(id)
    return
  }
  pending = id
  choose(id)
  // kept, in case the app is closed before it's switched: the next launch picks it up
  await AsyncStorage.setItem(PENDING_KEY, id).catch(() => {})
  if (!ANDROID_DEV) switchWhenAway(m)
}

/** Android development builds: the choice stays in the app (see the top). */
export const ANDROID_DEV = Platform.OS === 'android' && __DEV__

/** Android: the choice waiting for the app to leave the screen, kept across launches. */
const PENDING_KEY = 'bitcoinsv.appIcon.pending'

/**
 * The switch closes the app's screen, so it waits until you've left it; a try
 * that fails (no screen to read the current icon from) waits for the next.
 */
function switchWhenAway(m: IconsModule) {
  const native = (i: AppIconId) => APP_ICONS.find(x => x.id === i)?.native ?? null
  waiting ??= AppState.addEventListener('change', state => {
    const next = pending
    if (state !== 'background' || !next) return
    // forgotten first: the switch can end the app's process before it returns
    void AsyncStorage.removeItem(PENDING_KEY)
      .catch(() => {})
      .then(() => m.setAlternateAppIcon(native(next)))
      .then(
        () => {
          if (pending !== next) return
          pending = null
          waiting?.remove()
          waiting = null
        },
        () => void AsyncStorage.setItem(PENDING_KEY, next).catch(() => {})
      )
  })
}

// a choice from before the app was last closed
if (Platform.OS === 'android')
  void AsyncStorage.getItem(PENDING_KEY)
    .then(id => {
      const m = icons()
      if (!m || pending || !APP_ICONS.some(i => i.id === id)) return
      pending = id as AppIconId
      choose(pending)
      if (!ANDROID_DEV) switchWhenAway(m)
    })
    .catch(() => {})
