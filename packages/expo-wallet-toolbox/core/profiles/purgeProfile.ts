/**
 * Everything a removed profile leaves on this device, and the sweep that takes
 * it away.
 *
 * A profile is a function of the seed, so there is nothing on chain to delete —
 * what a removal erases is local: the profile's wallet databases on every
 * network, its ARC token, and the AsyncStorage keys that belong to it
 * (`profileScopedKey`: the base key with `__p<n>` appended).
 *
 * Run once when a removal lands, and again on every launch for every tombstone
 * in the store: a crash between the tombstone and this sweep must not leave a
 * "removed" profile's history on disk. So it is idempotent, each step stands on
 * its own (one that throws does not stop the rest), and the answer says whether
 * every step ran clean — which only the retry cares about.
 *
 * Nothing here is imported from the app: the four things it touches arrive as
 * `PurgeProfileIo`, so the sweep is testable without a device and the caller
 * owns the real stores.
 */
import type { ProfileRecord } from './profileStore'

export interface PurgeTarget {
  index: number
  /** Absent for a profile that never finished a build here, so it has no database. */
  identityKey?: string
}

export interface PurgeProfileIo {
  /** Every database registered for this identity (the last eight characters of its key), on every network. */
  purgeDbFiles(keySuffix: string): Promise<void>
  clearArcTokens(index: number): Promise<void>
  getAllKeys(): Promise<readonly string[]>
  removeKeys(keys: string[]): Promise<void>
}

/**
 * Anchored at the end of the key, with the index in full: `__p1` must not match
 * `__p10`, and profile 0 has no suffix at all so no pattern may ever match it.
 */
const suffixPattern = (index: number): RegExp => new RegExp(`__p${index}$`)

/**
 * Purge one profile's local data. Returns true when every step ran without
 * error. A profile 0 or a non-positive index is refused outright: profile 0's
 * keys are the bare ones, and sweeping by pattern could reach anything.
 */
export async function purgeProfile(target: PurgeTarget, io: PurgeProfileIo): Promise<boolean> {
  if (!Number.isInteger(target.index) || target.index <= 0) return false
  let clean = true
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      clean = false
      console.warn(`[profiles] purge of profile ${target.index} (${name}) failed`, err)
    }
  }

  const { identityKey } = target
  if (identityKey) await step('databases', () => io.purgeDbFiles(identityKey.slice(-8)))
  await step('arc token', () => io.clearArcTokens(target.index))
  await step('keys', async () => {
    const pattern = suffixPattern(target.index)
    const stale = (await io.getAllKeys()).filter(key => pattern.test(key))
    if (stale.length > 0) await io.removeKeys(stale)
  })
  return clean
}

/** The startup retry: purge every tombstone in `profiles`. Never throws. */
export async function purgeRemovedProfiles(profiles: readonly ProfileRecord[], io: PurgeProfileIo): Promise<void> {
  for (const profile of profiles) {
    if (!profile.deleted) continue
    await purgeProfile({ index: profile.index, identityKey: profile.identityKey }, io)
  }
}
