import AsyncStorage from '@react-native-async-storage/async-storage'
import type { PushAdapter } from './types'

export const PUSH_REGISTRATION_KEY = 'push_registration_v1'

export interface RegisterDeviceClient {
  registerDevice(
    params: { fcmToken: string; platform?: 'ios' | 'android'; deviceId?: string },
    overrideHost?: string
  ): Promise<unknown>
}

export type SyncResult = 'registered' | 'unchanged' | 'skipped' | 'failed'

/**
 * Make sure the MessageBox host knows this device's FCM token for this
 * identity. Idempotent: the last successful (host, identity, token) triple is
 * remembered, so the common case is no network call at all. Never throws —
 * push is an enhancement and must not take any caller down with it.
 */
export async function syncPushRegistration(args: {
  adapter: PushAdapter | undefined
  host: string | undefined
  identityKey: string | undefined
  makeClient: (host: string) => RegisterDeviceClient
  storage?: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }
}): Promise<SyncResult> {
  const { adapter, host, identityKey, makeClient } = args
  const storage = args.storage ?? AsyncStorage
  if (!adapter || !host || !identityKey) return 'skipped'
  let token: string | null | undefined
  try {
    if ((await adapter.getPermission()) !== 'granted') return 'skipped'
    token = await adapter.getToken()
    if (!token) return 'skipped'
    const marker = `${host}|${identityKey}|${token}`
    if ((await storage.getItem(PUSH_REGISTRATION_KEY)) === marker) return 'unchanged'
    await makeClient(host).registerDevice({ fcmToken: token, platform: adapter.platform }, host)
    await storage.setItem(PUSH_REGISTRATION_KEY, marker)
    return 'registered'
  } catch (e) {
    // Only the error's message is logged, so a failure is diagnosable without
    // the log ever carrying the token or the identity key. A message that
    // happens to quote the token, the identity key or the host has them cut out.
    const raw = e instanceof Error ? e.message : String(e)
    const message = [token, identityKey, host].reduce<string>(
      (text, secret) => (secret ? text.split(secret).join('[redacted]') : text),
      raw
    )
    console.warn('[push] registerDevice failed: ' + message)
    return 'failed'
  }
}
