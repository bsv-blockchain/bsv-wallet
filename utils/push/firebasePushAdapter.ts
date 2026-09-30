import { Linking, PermissionsAndroid, Platform } from 'react-native'
import {
  getMessaging,
  getToken,
  onTokenRefresh,
  onMessage,
  onNotificationOpenedApp,
  getInitialNotification,
  requestPermission,
  hasPermission,
  AuthorizationStatus
} from '@react-native-firebase/messaging'
import type { PushAdapter, PushPermission, PushOpenedEvent } from '@bsv/expo-wallet-toolbox'

const toEvent = (m: { data?: Record<string, unknown> } | null): PushOpenedEvent | null =>
  m ? { data: Object.fromEntries(Object.entries(m.data ?? {}).map(([k, v]) => [k, String(v)])) } : null

function fromIos(status: number): PushPermission {
  if (status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL) return 'granted'
  if (status === AuthorizationStatus.DENIED) return 'denied'
  return 'undetermined'
}

async function androidPermission(request: boolean): Promise<PushPermission> {
  if (Number(Platform.Version) < 33) return 'granted'
  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  if (await PermissionsAndroid.check(perm)) return 'granted'
  if (!request) return 'undetermined'
  const r = await PermissionsAndroid.request(perm)
  return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied'
}

const m = () => getMessaging()

export const firebasePushAdapter: PushAdapter = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  async getPermission() {
    return Platform.OS === 'ios' ? fromIos(await hasPermission(m())) : androidPermission(false)
  },
  async requestPermission() {
    return Platform.OS === 'ios' ? fromIos(await requestPermission(m())) : androidPermission(true)
  },
  async getToken() {
    try {
      return await getToken(m())
    } catch {
      return null
    }
  },
  onTokenRefresh: cb => onTokenRefresh(m(), cb),
  onNotificationOpened: cb => onNotificationOpenedApp(m(), msg => cb(toEvent(msg)!)),
  getInitialNotification: async () => toEvent(await getInitialNotification(m())),
  onForegroundMessage: cb => onMessage(m(), msg => cb(toEvent(msg)!)),
  openSettings: () => Linking.openSettings()
}
