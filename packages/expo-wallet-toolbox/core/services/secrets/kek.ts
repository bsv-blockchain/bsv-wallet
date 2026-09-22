/**
 * The key-encryption key: the one thing on this device that the OS refuses to
 * hand over without a biometric match.
 *
 * Everything else — the mnemonic, the recovered WIF — is AES-256-GCM
 * ciphertext sitting in ordinary unauthenticated storage. Reading those costs
 * zero prompts. Reading the KEK costs exactly one, once per process, because
 * the value is cached in memory afterwards. That is what buys "one Face ID
 * check at wallet instantiation, held until the process dies" without making
 * the check ceremonial: patching JavaScript now yields ciphertext.
 *
 * SECURITY: never log the KEK, and never re-export peekKek outside this
 * directory.
 */
import * as SecureStore from 'expo-secure-store'
import { Utils } from '@bsv/sdk'
import { generateKek, generateKekId } from './envelope'
import {
  hasStrongBiometrics,
  KEK_AUTH_KEY,
  KEK_PLAIN_KEY,
  needsUpgrade,
  policyFor,
  resolveProvisioningPolicy
} from './policy'
import { openKekWithPin, sealKekWithPin } from './pin'
import { clearFailures, lockRemainingMs, recordFailure } from './pinAttempts'
import { ENV_SERVICE, envOptions, kekOptions, PIN_ATTEMPTS_KEY, PIN_WRAP_KEY, SENTINEL_KEY } from './storage'
import { KekPolicy, KekSentinel, PinWrapV1, SecretName, UnavailableReason, UnlockState } from './types'

let cached: { kek: number[]; kekId: string; policy: KekPolicy } | null = null
let inFlight: Promise<UnlockState> | null = null
let state: UnlockState = { status: 'locked' }
let listeners: ((s: UnlockState) => void)[] = []

/** Latches once the user cancels or the device cannot authenticate, so we
 * never re-prompt on our own initiative. Only an explicit UI act clears it. */
let autoUnlockSpent = false

function setState(next: UnlockState): UnlockState {
  state = next
  for (const fn of listeners) fn(next)
  return next
}

export function getUnlockState(): UnlockState {
  return state
}

export function subscribeUnlockState(fn: (s: UnlockState) => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter(l => l !== fn)
  }
}

export function isUnlocked(): boolean {
  return cached !== null
}

/** Internal to services/secrets. */
export function peekKek(): { kek: number[]; kekId: string } | null {
  return cached ? { kek: cached.kek, kekId: cached.kekId } : null
}

/* ------------------------------- sentinel -------------------------------- */

export async function readSentinel(): Promise<KekSentinel | null> {
  try {
    const raw = await SecureStore.getItemAsync(SENTINEL_KEY, envOptions)
    if (!raw) return null
    const parsed = JSON.parse(raw) as KekSentinel
    return parsed?.v === 1 && typeof parsed.kekId === 'string' ? parsed : null
  } catch {
    return null
  }
}

async function writeSentinel(s: KekSentinel): Promise<void> {
  await SecureStore.setItemAsync(SENTINEL_KEY, JSON.stringify(s), envOptions)
}

export async function recordSecretName(name: SecretName): Promise<void> {
  const s = await readSentinel()
  if (!s || s.names.includes(name)) return
  await writeSentinel({ ...s, names: [...s.names, name] })
}

export async function forgetSecretName(name: SecretName): Promise<void> {
  const s = await readSentinel()
  if (!s || !s.names.includes(name)) return
  await writeSentinel({ ...s, names: s.names.filter(n => n !== name) })
}

/* ----------------------------- error mapping ------------------------------ */

/**
 * Neither platform gives us a usable numeric code through this module — iOS
 * drops the OSStatus from its message and Android collapses distinct failures
 * into shared strings — so this is string matching, and it is brittle by
 * necessity. Re-check it whenever expo-secure-store is bumped.
 *
 * The default is deliberately benign. An unrecognised error becomes
 * `cancelled`, which renders as a retry button; classifying an unknown as
 * `unavailable` would show a dead-end "this device can't do this" screen for
 * something as ordinary as the app being backgrounded mid-sheet.
 */
export function classifyAuthError(err: unknown): UnlockState {
  const msg = String((err as Error)?.message ?? err ?? '')
  const unavailable = (reason: UnavailableReason): UnlockState => ({ status: 'unavailable', reason })

  if (/cancel/i.test(msg)) return { status: 'cancelled' }
  if (/lockout|too many attempts/i.test(msg)) return unavailable('lockout')
  if (/no biometrics|not currently enrolled|no user authentication method|passcode/i.test(msg)) {
    return unavailable('not-enrolled')
  }
  if (/no hardware|not available|unsupported/i.test(msg)) return unavailable('no-hardware')
  if (/foreground|FragmentActivity/i.test(msg)) return unavailable('not-foregrounded')
  return { status: 'cancelled' }
}

/* ------------------------------ provisioning ------------------------------ */

/**
 * Mint a KEK for a device that has none. Returns it already cached — we never
 * read back what we just wrote, because on an authenticated item that would be
 * a second prompt.
 */
export async function provisionKek(): Promise<UnlockState> {
  const resolved = await resolveProvisioningPolicy()
  const kek = generateKek()
  const kekId = generateKekId()

  // Delete-then-add, never blind-write: writing over an existing item takes
  // iOS's update path, which prompts a second time on an ACL item.
  await deleteBothKekItems()

  try {
    await SecureStore.setItemAsync(
      resolved.keyName,
      Utils.toHex(kek),
      kekOptions(resolved.requireAuthentication)
    )
  } catch (err) {
    return setState(classifyAuthError(err))
  }

  await writeSentinel({
    v: 1,
    kekId,
    policy: resolved.policy,
    provisionedAt: Date.now(),
    names: []
  })

  cached = { kek, kekId, policy: resolved.policy }
  return setState({ status: 'unlocked', kekId, policy: resolved.policy })
}

async function deleteBothKekItems(): Promise<void> {
  // Deletion never prompts on either platform.
  await SecureStore.deleteItemAsync(KEK_AUTH_KEY, kekOptions(true)).catch(() => {})
  await SecureStore.deleteItemAsync(KEK_PLAIN_KEY, kekOptions(false)).catch(() => {})
}

/* --------------------------------- unlock --------------------------------- */

/**
 * Release the KEK, prompting at most once per process.
 *
 * Never mints a key: if a sentinel exists and the KEK does not, the OS
 * destroyed it (biometric re-enrolment, screen-lock removal, reinstall) and the
 * honest answer is `lost`, not a silent fresh start that would strand the
 * user's coins behind an envelope nobody can open.
 */
export async function unlockKek(promptMessage?: string): Promise<UnlockState> {
  if (cached) {
    return setState({ status: 'unlocked', kekId: cached.kekId, policy: cached.policy })
  }
  // Single-flight: Android throws outright on a concurrent prompt.
  if (inFlight) return inFlight

  inFlight = doUnlock(promptMessage).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Auto-unlock at most once per process. After a cancellation or an
 * unavailable device we stop initiating, so the user is never trapped in a
 * prompt loop — but the first cold-start unlock stays implicit, which is what
 * keeps the existing UX (one sheet, no extra tap). */
export async function autoUnlockKek(promptMessage?: string): Promise<UnlockState> {
  if (cached) return unlockKek(promptMessage)
  if (autoUnlockSpent) return state
  autoUnlockSpent = true
  return unlockKek(promptMessage)
}

async function doUnlock(promptMessage?: string): Promise<UnlockState> {
  const sentinel = await readSentinel()
  // No sentinel: nothing was ever stored. Touch SecureStore at all here and a
  // brand-new user would get a biometric sheet on the welcome screen.
  if (!sentinel) return setState({ status: 'absent' })
  if (sentinel.names.length === 0) return setState({ status: 'absent' })

  setState({ status: 'unlocking' })

  // PIN-only: there is no keychain item to ask for. Nothing here can make
  // progress without the user, so hand straight back to the UI.
  if (sentinel.policy === 'pin') return setState(await needsPin())

  const resolved = policyFor(sentinel.policy)
  let raw: string | null
  try {
    raw = await SecureStore.getItemAsync(
      resolved.keyName,
      kekOptions(resolved.requireAuthentication, promptMessage)
    )
  } catch (err) {
    // A cancelled or unsatisfiable biometric ceremony is not a dead end when a
    // PIN wrap exists — that is the whole reason to have one. Same move iOS
    // itself makes when Face ID fails: fall through to the code.
    if (await hasPin()) return setState(await needsPin())
    return setState(classifyAuthError(err))
  }

  // A sentinel with no key means the OS threw the key away — biometric
  // re-enrolment, screen-lock removal. Historically terminal; with a PIN wrap
  // it is merely the moment the PIN earns its keep, because the wrap holds the
  // same KEK and the OS has no say over it.
  if (raw === null) {
    if (await hasPin()) return setState(await needsPin())
    return setState({ status: 'lost' })
  }

  cached = { kek: Utils.toArray(raw, 'hex') as number[], kekId: sentinel.kekId, policy: sentinel.policy }

  // A production build must not keep running on a KEK that a development
  // build provisioned without OS enforcement.
  if (await needsUpgrade(sentinel.policy)) {
    const upgraded = await upgradeToBiometric(sentinel)
    if (upgraded) return setState(upgraded)
  }

  return setState({ status: 'unlocked', kekId: sentinel.kekId, policy: cached.policy })
}

/**
 * Re-wrap the same KEK value under an authenticated item. The envelope blobs
 * are untouched because the KEK itself does not change.
 */
export async function upgradeToBiometric(sentinel: KekSentinel): Promise<UnlockState | null> {
  if (!cached) return null
  try {
    await SecureStore.deleteItemAsync(KEK_AUTH_KEY, kekOptions(true)).catch(() => {})
    await SecureStore.setItemAsync(KEK_AUTH_KEY, Utils.toHex(cached.kek), kekOptions(true))
    await writeSentinel({ ...sentinel, policy: 'biometric' })
    await SecureStore.deleteItemAsync(KEK_PLAIN_KEY, kekOptions(false)).catch(() => {})
    cached = { ...cached, policy: 'biometric' }
    return { status: 'unlocked', kekId: cached.kekId, policy: 'biometric' }
  } catch {
    // Leave the install exactly as it was; we still hold the KEK in memory for
    // this session and will retry the upgrade on the next launch.
    return null
  }
}

/* -------------------------------- teardown -------------------------------- */

/** Prompt-free, and works while locked or lost — otherwise a user whose
 * biometrics changed could never log out. */
export async function destroyKek(): Promise<void> {
  cached = null
  autoUnlockSpent = false
  await deleteBothKekItems()
  // The PIN wrap is another copy of the very key being destroyed; leaving it
  // behind would keep the wallet openable after a wipe.
  await SecureStore.deleteItemAsync(PIN_WRAP_KEY, envOptions).catch(() => {})
  await SecureStore.deleteItemAsync(PIN_ATTEMPTS_KEY, envOptions).catch(() => {})
  await SecureStore.deleteItemAsync(SENTINEL_KEY, envOptions).catch(() => {})
  setState({ status: 'absent' })
}

/** Drop the in-memory copy without touching storage (e.g. explicit re-lock). */
export function lockKek(): void {
  cached = null
  autoUnlockSpent = false
  setState({ status: 'locked' })
}

export function __resetForTests(): void {
  cached = null
  inFlight = null
  listeners = []
  autoUnlockSpent = false
  state = { status: 'locked' }
}

/* ---------------------------------- PIN ----------------------------------- */

/**
 * The PIN is a SECOND wrap of the same KEK, never a second key. Every envelope
 * blob stays sealed under the one KEK value, so turning a PIN on or off, or
 * changing it, rewrites 150 bytes and touches no secret. That is what makes
 * these operations safe to expose in Settings at all.
 */

async function needsPin(): Promise<UnlockState> {
  return { status: 'needs-pin', retryAfterMs: await lockRemainingMs() }
}

export async function readPinWrap(): Promise<PinWrapV1 | null> {
  try {
    const raw = await SecureStore.getItemAsync(PIN_WRAP_KEY, envOptions)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PinWrapV1
    return parsed?.v === 1 && typeof parsed.c === 'string' ? parsed : null
  } catch {
    return null
  }
}

export async function hasPin(): Promise<boolean> {
  return (await readPinWrap()) !== null
}

/** Whether the OS-enforced copy of the KEK is the one in play. */
export async function isBiometricEnabled(): Promise<boolean> {
  const s = await readSentinel()
  return s?.policy === 'biometric'
}

/**
 * Turn a PIN on, or replace the current one.
 *
 * Requires the KEK to be in hand: the caller must already have unlocked this
 * session by whatever means. That is deliberate — it makes "set a PIN" an
 * operation only the legitimate owner of an open wallet can perform, with no
 * separate authorisation path to get wrong.
 */
export async function setPin(pin: string): Promise<boolean> {
  if (!cached) return false
  try {
    const wrap = await sealKekWithPin(cached.kek, cached.kekId, pin)
    await SecureStore.setItemAsync(PIN_WRAP_KEY, JSON.stringify(wrap), envOptions)
    await clearFailures()
    return true
  } catch {
    return false
  }
}

/** Verify the old PIN before replacing it, so a shoulder-surfer with a warm
 * phone cannot silently change the code out from under the owner. */
export async function changePin(oldPin: string, newPin: string): Promise<boolean> {
  const wrap = await readPinWrap()
  if (!wrap || !cached) return false
  if (await lockRemainingMs() > 0) return false
  const kek = await openKekWithPin(wrap, oldPin)
  if (!kek) {
    await recordFailure()
    return false
  }
  return setPin(newPin)
}

/**
 * Turn the PIN off.
 *
 * Refused when it is the only way in: on a PIN-only install, removing the wrap
 * destroys the last copy of the KEK and every secret under it. The caller is
 * expected to offer "switch Face ID back on" instead, which setBiometricEnabled
 * does in the right order.
 */
export async function clearPin(): Promise<boolean> {
  const s = await readSentinel()
  if (s?.policy === 'pin') return false
  await SecureStore.deleteItemAsync(PIN_WRAP_KEY, envOptions).catch(() => {})
  await clearFailures()
  return true
}

/**
 * Enter a PIN. Throttled by pinAttempts, which is the control that makes a
 * six-digit secret defensible at all.
 */
export async function unlockWithPin(pin: string): Promise<UnlockState> {
  const sentinel = await readSentinel()
  if (!sentinel) return setState({ status: 'absent' })

  const wrap = await readPinWrap()
  if (!wrap) return setState({ status: 'lost' })

  const owed = await lockRemainingMs()
  if (owed > 0) return setState({ status: 'needs-pin', retryAfterMs: owed })

  const kek = await openKekWithPin(wrap, pin)
  if (!kek) {
    await recordFailure()
    return setState(await needsPin())
  }

  // A wrap that opens but names a different KEK is a stale record from a
  // previous wallet on this device. Honouring it would decrypt nothing.
  if (wrap.kekId !== sentinel.kekId) {
    await SecureStore.deleteItemAsync(PIN_WRAP_KEY, envOptions).catch(() => {})
    return setState({ status: 'lost' })
  }

  await clearFailures()
  autoUnlockSpent = true
  cached = { kek, kekId: sentinel.kekId, policy: sentinel.policy }
  return setState({ status: 'unlocked', kekId: sentinel.kekId, policy: sentinel.policy })
}

/**
 * Switch the OS-enforced wrap on or off.
 *
 * Turning it OFF is only allowed once a PIN exists, and writes the PIN-only
 * policy BEFORE deleting the keychain item, so a crash between the two leaves
 * an install that asks for a PIN it can satisfy rather than one that looks for
 * a key that is gone.
 */
export async function setBiometricEnabled(enabled: boolean): Promise<boolean> {
  const sentinel = await readSentinel()
  if (!sentinel || !cached) return false

  if (!enabled) {
    if (!(await hasPin())) return false
    try {
      await writeSentinel({ ...sentinel, policy: 'pin' })
      await SecureStore.deleteItemAsync(KEK_AUTH_KEY, kekOptions(true)).catch(() => {})
      await SecureStore.deleteItemAsync(KEK_PLAIN_KEY, kekOptions(false)).catch(() => {})
      cached = { ...cached, policy: 'pin' }
      setState({ status: 'unlocked', kekId: cached.kekId, policy: 'pin' })
      return true
    } catch {
      return false
    }
  }

  if (!(await hasStrongBiometrics())) return false
  const upgraded = await upgradeToBiometric(sentinel)
  if (!upgraded) return false
  setState(upgraded)
  return true
}

export { ENV_SERVICE }
