// Development builds only (EXPO_PUBLIC_PUSH_SIMULATE=true, and no Firebase
// registration): a push adapter that plays pushes into the app instead of
// receiving them, so the routing (src/notify/pushRouting.ts and the core's
// handlers) can be tried before BSVA's Firebase project exists. It never has a
// token, so the core never registers this device with a MessageBox server.
// Settings → Advanced → Push simulator plays them (app/dev-push.tsx).
import { Linking, Platform } from 'react-native'
import type { PushAdapter, PushOpenedEvent } from '@bsv/expo-wallet-toolbox'

type Cb = (e: PushOpenedEvent) => void
const opened = new Set<Cb>()
const foreground = new Set<Cb>()
let initial: PushOpenedEvent | null = null

export const devPushAdapter: PushAdapter = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  getPermission: async () => 'granted',
  requestPermission: async () => 'granted',
  getToken: async () => null,
  onTokenRefresh: () => () => {},
  onNotificationOpened: cb => {
    opened.add(cb)
    return () => opened.delete(cb)
  },
  getInitialNotification: async () => {
    const e = initial
    initial = null
    return e
  },
  onForegroundMessage: cb => {
    foreground.add(cb)
    return () => foreground.delete(cb)
  },
  openSettings: () => Linking.openSettings()
}

/** A push arriving while the app is open, or tapped from the notification centre. */
export function simulatePush(data: Record<string, string>, how: 'foreground' | 'tap') {
  const e = { data }
  ;(how === 'tap' ? opened : foreground).forEach(cb => cb(e))
}
