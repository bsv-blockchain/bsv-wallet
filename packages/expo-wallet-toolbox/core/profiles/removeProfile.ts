/**
 * Removing a wallet profile: what runs, in what order, and where it stops.
 *
 * A profile is a pure function of the seed, so it can never be destroyed — to
 * remove one is to forget it on this device and withdraw its public handle. What
 * makes that safe is that nothing the profile holds is left unwatched, and what
 * makes it recoverable is the order: everything that can fail is done before
 * anything is changed here.
 *
 *   1. Guards, then the proof that the profile is empty (`checkEmpty`): the open
 *      database and the profile's databases for every other network.
 *   2. Release the handle, if the registry shows one for this identity — bounded
 *      in time, and followed by the proof again, since the release is a network
 *      round trip during which the profile's inbox tasks keep running.
 *   3. (The remote backup is kept: a removed profile can reappear after a
 *      reinstall and seed import, empty, and be removed again.)
 *   4. Disconnect the paired session — `switchToDefault` does this first thing.
 *   5. Switch to profile 0 through the normal switch. Its teardown lets the
 *      profile's monitor finish its pass, which can still credit something, so
 *      once the profile is closed...
 *   5b. ...its databases are checked a last time from their files (`checkClosed`):
 *      nothing writes to them any more, so what they hold now is final.
 *   6. Only once that has landed and found nothing: tombstone the record, purge
 *      its databases and keys, and withdraw its push registration.
 *
 * Everything before 5 aborts with the store exactly as it was, and a switch that
 * does not land aborts too, so a failure never strands a profile half-removed.
 * A last check that finds something aborts as well: the profile stays exactly
 * as it was, databases included, and profile 0 is the one that is open. The
 * handle is the one thing that cannot be taken back after step 2: it was
 * released first because releasing needs the live wallet's signer, which the
 * switch tears down.
 *
 * The flow touches nothing itself. The open database, the registry, the switch
 * and the stores arrive as `RemoveProfileDeps`, so the ordering is testable
 * against the real profile store without a device.
 */
import type { ProfileEmptyResult, RemovalBlocker } from './assertProfileEmpty'
import type { RegistrationResult } from '../identity/handleRegistry/registration'
import type { ProfileRecord } from './profileStore'

/** Why a removal was not even attempted. */
export type RemoveRefusal =
  /** A recovered-key wallet has no profiles. */
  | 'unsupported'
  | 'profile-zero'
  /** Not the open profile, or already removed. */
  | 'not-active'
  /** Another switch or removal is running. Set by the caller: it owns that flag. */
  | 'busy'
  /** The wallet is not open (still building, or its build failed), or its identity is unknown. */
  | 'not-ready'
  | 'offline'

/** What the registry says about this identity's handle. `failed` is no answer, which is not "none". */
export type HandleLookup = { kind: 'found'; paymail: string } | { kind: 'none' } | { kind: 'failed' }

/** The outcome of asking whether a profile could be removed now. Changes nothing. */
export type ProfileRemovalCheck =
  /** `handle` is what would be released, for the confirm copy. */
  | { kind: 'ok'; handle: string | null }
  | { kind: 'refused'; reason: RemoveRefusal }
  | { kind: 'blocked'; reasons: RemovalBlocker[] }
  /** The registry could not be read or the handle could not be released: a handle that may still be held blocks removal. */
  | { kind: 'handle-failed' }
  | { kind: 'failed'; message: string }

export type RemoveProfileResult =
  | { kind: 'removed'; index: number }
  /**
   * Excludes nothing from the check's own answers, so `blocked` also covers a
   * profile that was empty when the removal began and was not by the time it
   * had to be (money credited during the handle release or the switch). In that
   * case the handle, if there was one, is already released, and after the
   * switch profile 0 is the open profile; nothing else was changed.
   */
  | Exclude<ProfileRemovalCheck, { kind: 'ok' }>
  /** The switch to profile 0 did not land. Nothing was removed; the handle, if there was one, is already released. */
  | { kind: 'switch-failed' }

export interface RemoveProfileDeps {
  /** The profile to remove: the one that is open. */
  index: number
  /** False for a recovered-key wallet. */
  supported: boolean
  activeIndex(): number
  record(): ProfileRecord | undefined
  /** The wallet for this profile is open: storage, user and signer are all there. */
  ready(): boolean
  online(): Promise<boolean>
  /** The identity as the live wallet reports it, for a record that never stored one. */
  liveIdentityKey(): Promise<string | undefined>
  /**
   * Finish whatever handle write is journalled, so it is not what blocks the
   * check (a release that timed out leaves one behind). True when nothing is
   * left outstanding.
   */
  settleHandleJournal(): Promise<boolean>
  /**
   * The proof that the profile holds nothing, for this identity: the open
   * database AND its databases for every other network, since removal deletes all
   * of them. Asked once before the handle is released and, when a handle was
   * released, again after.
   */
  checkEmpty(identityKey: string): Promise<ProfileEmptyResult>
  /** Asked of the registry by the identity, which is what the registry keys a handle on. */
  lookupHandle(identityKey: string): Promise<HandleLookup>
  releaseHandle(paymail: string): Promise<RegistrationResult>
  /** The normal switch, with its cover. True when profile 0 is open and built. */
  switchToDefault(): Promise<boolean>
  /**
   * What the profile's databases hold now that its wallet is down — every file
   * registered for the identity, read from the files themselves. Asked after the
   * switch has landed, so whatever the profile's monitor credited while it shut
   * down is in them.
   */
  checkClosed(identityKey: string): Promise<ProfileEmptyResult>
  tombstone(identityKey: string): Promise<void>
  purge(target: { index: number; identityKey: string }): Promise<void>
  /** The push hook: withdraw this identity's device registration. Best effort, never a reason to fail. */
  unregisterPush(target: { index: number; identityKey: string }): Promise<void>
}

/**
 * How long the registry gets to answer a release. The wallet is untouched until
 * it has, so waiting costs only the cover; a registry that never answers must
 * not hold the cover up for good. A release that lands after this has no effect
 * here but a handle released: its journal is finished by the next attempt.
 */
export const HANDLE_RELEASE_TIMEOUT_MS = 20_000

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `work`'s result, or `undefined` once `ms` have passed. Leaves no timer behind. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The guards that need no network and no wallet call: whether this profile may
 * be removed at all. The caller can ask before it starts a transition, so a
 * profile that was never eligible does not flash a cover.
 */
export function removalRefusal(deps: RemoveProfileDeps): RemoveRefusal | null {
  if (!deps.supported) return 'unsupported'
  if (deps.index === 0) return 'profile-zero'
  const record = deps.record()
  if (!record || record.deleted || deps.activeIndex() !== deps.index) return 'not-active'
  if (!deps.ready()) return 'not-ready'
  return null
}

/** Guards, the emptiness proof and the handle lookup: everything that changes nothing. */
async function prepare(
  deps: RemoveProfileDeps
): Promise<
  { kind: 'ready'; identityKey: string; handle: string | null } | Exclude<ProfileRemovalCheck, { kind: 'ok' }>
> {
  const refusal = removalRefusal(deps)
  if (refusal) return { kind: 'refused', reason: refusal }
  const record = deps.record()
  try {
    // The tombstone keeps the identity, and the purge finds the databases by it.
    const identityKey = record?.identityKey ?? (await deps.liveIdentityKey())
    if (!identityKey) return { kind: 'refused', reason: 'not-ready' }
    if (!(await deps.online())) return { kind: 'refused', reason: 'offline' }

    if (!(await deps.settleHandleJournal())) return { kind: 'handle-failed' }
    const empty = await deps.checkEmpty(identityKey)
    if (!empty.ok) return { kind: 'blocked', reasons: empty.reasons }

    const lookup = await deps.lookupHandle(identityKey)
    if (lookup.kind === 'failed') return { kind: 'handle-failed' }
    return { kind: 'ready', identityKey, handle: lookup.kind === 'found' ? lookup.paymail : null }
  } catch (e) {
    return { kind: 'failed', message: messageOf(e) }
  }
}

/** Would removing this profile work right now? Reads and decides; changes nothing. */
export async function checkProfileRemoval(deps: RemoveProfileDeps): Promise<ProfileRemovalCheck> {
  const prepared = await prepare(deps)
  return prepared.kind === 'ready' ? { kind: 'ok', handle: prepared.handle } : prepared
}

export async function removeProfileFlow(deps: RemoveProfileDeps): Promise<RemoveProfileResult> {
  const prepared = await prepare(deps)
  if (prepared.kind !== 'ready') return prepared
  const { identityKey, handle } = prepared
  const target = { index: deps.index, identityKey }

  // Step 2. Only a `released` answer means the handle is gone: any other kind
  // (including an unrelated journal finished in its place), and no answer in
  // time, leave it held.
  if (handle !== null) {
    try {
      const released = await within(deps.releaseHandle(handle), HANDLE_RELEASE_TIMEOUT_MS)
      if (released?.kind !== 'released') return { kind: 'handle-failed' }
      // The release was a network round trip, and the profile's inbox tasks kept
      // running throughout: what they credited since the proof above is not in it.
      const again = await deps.checkEmpty(identityKey)
      if (!again.ok) return { kind: 'blocked', reasons: again.reasons }
    } catch (e) {
      return { kind: 'failed', message: messageOf(e) }
    }
  }

  // Steps 4 and 5. A `true` from the switch is not enough: it also answers true
  // for a build that was overtaken (a logout, say), which says nothing about
  // where the store points. Profile 0 must be the open one before anything is
  // tombstoned.
  let landed = false
  try {
    landed = await deps.switchToDefault()
  } catch {
    landed = false
  }
  if (!landed || deps.activeIndex() !== 0) return { kind: 'switch-failed' }

  // Step 5b. The switch let the profile's monitor finish its pass before its
  // storage was closed, and that pass can credit a payment after every proof so
  // far. Nothing writes to the databases now, so this is the last word: anything
  // in them, or any failure to look, keeps them.
  try {
    const left = await deps.checkClosed(identityKey)
    if (!left.ok) return { kind: 'blocked', reasons: left.reasons }
  } catch (e) {
    return { kind: 'failed', message: messageOf(e) }
  }

  // Step 6. The tombstone is the removal; what follows is cleanup that the
  // startup retry repeats, so it can fail without undoing anything.
  try {
    await deps.tombstone(identityKey)
  } catch (e) {
    return { kind: 'failed', message: messageOf(e) }
  }
  try {
    await deps.purge(target)
  } catch (err) {
    console.warn(`[profiles] purge of removed profile ${deps.index} failed; it is retried at startup`, err)
  }
  try {
    await deps.unregisterPush(target)
  } catch (err) {
    console.warn(`[profiles] push unregister for removed profile ${deps.index} failed`, err)
  }
  return { kind: 'removed', index: deps.index }
}
