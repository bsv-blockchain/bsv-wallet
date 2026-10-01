/**
 * Push for every profile of a wallet, for the life of one wallet build.
 *
 * One install has one FCM token, and every live profile registers it with its
 * own MessageBox host under its own identity (see registration.ts), so a payment
 * to any profile wakes the phone. Everything the sync needs about the profiles is
 * handed in once, when the build is wired — their identities and signing wallets,
 * and how to read a host or tell whether a profile is still wanted — so the sync
 * can run from any trigger without reaching for the open profile.
 */
import { coalesceRuns } from './events'
import type { PushProfile } from './identities'
import {
  forgetPushMarker,
  syncPushRegistrations,
  unregisterPushIdentity,
  type PushMarkerStorage,
  type PushPost,
  type PushTarget,
  type RegisterDeviceClient
} from './registration'
import type { PushAdapter } from './types'

export interface ProfilePushDeps {
  adapter: PushAdapter | undefined
  /** Every live profile of this build, the open one included. */
  profiles: readonly PushProfile[]
  /** The profile this build belongs to: it registers last. */
  activeIndex: number
  /** That profile's MessageBox host, read from its own settings; undefined when MessageBox is off for it. */
  readHost(index: number): Promise<string | undefined>
  /** False once the profile was removed or this build was replaced. Asked at every step. */
  isCurrent(index: number): boolean
  makeClient(wallet: unknown, host: string): RegisterDeviceClient
  makePost(wallet: unknown): PushPost
  storage?: PushMarkerStorage
}

export interface ProfilePush {
  /** Register every profile that needs it. Serialised and coalesced; never rejects. */
  sync(): Promise<void>
  /**
   * Withdraw the registrations of `identityKeys` (every profile of this build when
   * omitted), all at once. Best effort and bounded in time: never rejects.
   */
  unregister(identityKeys?: readonly string[]): Promise<void>
  /** The index of the live profile, other than the open one, whose identity key is `recipient`. */
  inactiveProfileFor(recipient: string): number | undefined
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function createProfilePush(deps: ProfilePushDeps): ProfilePush {
  const { adapter, profiles, activeIndex, storage } = deps

  const sync = coalesceRuns(async () => {
    if (!adapter) return
    const live = profiles.filter(p => deps.isCurrent(p.index))
    const targets: PushTarget[] = await Promise.all(
      live.map(async p => {
        let host: string | undefined
        try {
          host = await deps.readHost(p.index)
        } catch (e) {
          console.warn(`[push] could not read the MessageBox host: ${e instanceof Error ? e.message : String(e)}`)
        }
        return {
          index: p.index,
          identityKey: p.identityKey,
          host,
          active: p.index === activeIndex,
          makeClient: (h: string) => deps.makeClient(p.wallet, h),
          isCurrent: () => deps.isCurrent(p.index)
        }
      })
    )
    const results = await syncPushRegistrations({ adapter, targets, storage })
    if (results.some(r => r.result === 'failed'))
      console.warn('[push] device registration with the MessageBox host failed')
  })

  const unregister = async (identityKeys?: readonly string[]): Promise<void> => {
    const wanted = identityKeys ?? profiles.map(p => p.identityKey)
    await Promise.all(
      wanted.map(async identityKey => {
        try {
          const profile = profiles.find(p => sameKey(p.identityKey, identityKey))
          // A key this build holds no wallet for cannot sign a request, but its
          // marker still has no business staying behind.
          if (!profile) return await forgetPushMarker(identityKey, storage)
          await unregisterPushIdentity({
            identityKey: profile.identityKey,
            post: deps.makePost(profile.wallet),
            storage
          })
        } catch (e) {
          console.warn(`[push] unregister failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
    )
  }

  const inactiveProfileFor = (recipient: string): number | undefined => {
    const match = profiles.find(p => p.index !== activeIndex && sameKey(p.identityKey, recipient))
    return match && deps.isCurrent(match.index) ? match.index : undefined
  }

  return { sync, unregister, inactiveProfileFor }
}
