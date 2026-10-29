/** Public API of `@bsv/expo-android-wallet-bridge` (grows with the controller tasks; spec 6.12). */
export { getBsvAndroidBridge } from './native'
export type {
  BsvAndroidBridgeNative,
  BsvAndroidBridgeEvents,
  NativeHeaders,
  NativeLaunch,
  NativeRequest,
  ServerStopReason
} from './native'
export { createSecureStoreContinuity, deriveContextIdentity } from './continuity/secureStoreContinuity'

export { setupAndroidBridge, resetAndroidBridge, getAndroidBridge, ANDROID_TRANSPORT_ID } from './setup'
export type { SetupOptions } from './setup'
