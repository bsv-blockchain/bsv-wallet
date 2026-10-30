/**
 * Local answers (spec 6.10): the only three methods the extension answers without the app, each only
 * for a bound, open epoch. Everything else (undefined) is staged.
 */
import type { Mirror } from '../../../shared/mirror'
import { connectedHash } from '../../../shared/mirror'
import type { EpochBinding } from './bindings'

const IDENTITY_KEY = /^[0-9a-f]{66}$/

function isExactlyIdentityKey(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  const keys = Object.keys(args)
  return keys.length === 1 && keys[0] === 'identityKey' && (args as { identityKey: unknown }).identityKey === true
}

/**
 * `epochBinding` is undefined when the epoch is not bound here or has been closed. `mirror` is undefined
 * when the mirror is absent or corrupt. `origin` is the attested frame origin.
 */
export function localAnswer(
  method: string,
  args: unknown,
  epochBinding: EpochBinding | undefined,
  mirror: Mirror | undefined,
  origin: string
): { answer: unknown } | undefined {
  if (!epochBinding || !mirror) return undefined
  if (epochBinding.origin !== origin) return undefined
  const snap = mirror.snapshot
  if (snap.readiness === 'none') return undefined

  switch (method) {
    case 'getVersion':
      return { answer: { version: snap.baseVersion } }
    case 'isAuthenticated':
      return { answer: { authenticated: snap.readiness === 'ready' } }
    case 'getPublicKey': {
      if (!isExactlyIdentityKey(args)) return undefined // 1
      if (snap.readiness !== 'ready') return undefined // 3
      if (snap.walletRevision !== epochBinding.walletRevision || snap.accountContext !== epochBinding.accountContext) {
        return undefined // 3
      }
      if (!mirror.connected.includes(connectedHash(origin))) return undefined // 4
      if (mirror.identityKeyPrompts !== false) return undefined // 5
      if (typeof mirror.identityKey !== 'string' || !IDENTITY_KEY.test(mirror.identityKey)) return undefined // 6
      return { answer: { publicKey: mirror.identityKey } }
    }
    default:
      return undefined
  }
}
