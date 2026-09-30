export type PushPermission = 'granted' | 'denied' | 'undetermined'

export interface PushOpenedEvent {
  /** Data payload from the push (messageId, originator). */
  data: Record<string, string>
}

/**
 * The host's push implementation. This package never imports a push SDK: the
 * host wraps whichever one it ships (e.g. React Native Firebase Messaging) in
 * this shape and hands it over through `configureToolbox({ push })`.
 *
 * New members will be added as optional, so an adapter written against this
 * shape keeps compiling and working when the package is updated.
 */
export interface PushAdapter {
  readonly platform: 'ios' | 'android'
  getPermission(): Promise<PushPermission>
  /** Shows the OS dialog when undetermined; resolves to the result. */
  requestPermission(): Promise<PushPermission>
  /** FCM registration token, or null when unavailable. */
  getToken(): Promise<string | null>
  onTokenRefresh(cb: (token: string) => void): () => void
  /** Tap while backgrounded. */
  onNotificationOpened(cb: (e: PushOpenedEvent) => void): () => void
  /** Tap that launched the app from killed; null when not launched by a tap. */
  getInitialNotification(): Promise<PushOpenedEvent | null>
  /** Push received while app is foreground. */
  onForegroundMessage(cb: (e: PushOpenedEvent) => void): () => void
  openSettings(): Promise<void>
}
