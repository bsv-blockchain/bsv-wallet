/**
 * Read/write wallet secrets through the envelope.
 *
 * Every operation here except the first unlock is prompt-free, because the
 * ciphertexts are unauthenticated items and the KEK is already in memory.
 *
 * SECURITY: never log values passed through these functions.
 */
import * as SecureStore from 'expo-secure-store'
import { openSecret, sealSecret, assertKekId } from './envelope'
import { destroyKek, forgetSecretName, peekKek, provisionKek, readSentinel, recordSecretName, unlockKek } from './kek'
import { sweepLegacyKeys } from './migration'
import { envKey, envOptions } from './storage'
import { EnvelopeBlob, EnvelopeError, SECRET_NAMES, SecretName } from './types'

/**
 * Is there a wrapped secret of this name? Prompt-free and works while locked.
 *
 * Note this is not strictly side-effect-free on Android: reading a blob whose
 * unauthenticated Keystore alias has gone missing makes the native module drop
 * the stale ciphertext. Harmless — it was already unopenable — but don't call
 * it speculatively in a hot path.
 */
export async function hasSecret(name: SecretName, options?: { strict?: boolean }): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(envKey(name), envOptions)) !== null
  } catch (err) {
    // Creation must distinguish an unreadable keychain from an empty one.
    if (options?.strict) throw err
    return false
  }
}

export async function hasAnySecret(options?: { strict?: boolean }): Promise<boolean> {
  for (const name of SECRET_NAMES) {
    if (await hasSecret(name, options)) return true
  }
  return false
}

/**
 * Returns null when locked. It deliberately does NOT unlock implicitly — the
 * one automatic unlock per process is initiated from the wallet-build effect,
 * where a prompt is expected, not from whichever screen happens to read a
 * secret first.
 */
export async function getSecret(name: SecretName): Promise<string | null> {
  const held = peekKek()
  if (!held) return null

  let raw: string | null
  try {
    raw = await SecureStore.getItemAsync(envKey(name), envOptions)
  } catch (err) {
    console.warn('[secrets] read failed', name, (err as Error)?.message)
    return null
  }
  if (!raw) return null

  try {
    const blob = JSON.parse(raw) as EnvelopeBlob
    assertKekId(blob, held.kekId)
    return openSecret(held.kek, name, blob)
  } catch (err) {
    const code = err instanceof EnvelopeError ? err.code : 'corrupt'
    console.warn('[secrets] could not open envelope', name, code)
    return null
  }
}

/**
 * Seal and store. Provisions a KEK on first use, which is the only moment a
 * write can prompt (and only on Android, where minting an auth-bound key
 * requires a ceremony).
 *
 * The sentinel read here is `{ strict: true }` (P2-store-transient-sentinel):
 * a null sentinel means "provision a fresh KEK", and provisionKek() deletes
 * both KEK keychain items unconditionally before minting a new one. A
 * transient read failure must never be read the same way as a genuinely
 * absent sentinel — that would delete a real KEK out from under an
 * already-sealed envelope, orphaning it beyond recovery. Refusing the write
 * (same externally-visible shape as a declined biometric prompt) is the safe
 * failure here, not a silent re-provision.
 */
export async function putSecret(name: SecretName, value: string): Promise<boolean> {
  let held = peekKek()

  if (!held) {
    let sentinel: Awaited<ReturnType<typeof readSentinel>>
    try {
      sentinel = await readSentinel({ strict: true })
    } catch (err) {
      console.warn(
        '[secrets] sentinel read failed; refusing to write rather than re-provision',
        name,
        (err as Error)?.message
      )
      return false
    }
    const result = sentinel ? await unlockKek() : await provisionKek()
    if (result.status !== 'unlocked') return false
    held = peekKek()
    if (!held) return false
  }

  try {
    const blob = sealSecret(held.kek, held.kekId, name, value)
    await SecureStore.setItemAsync(envKey(name), JSON.stringify(blob), envOptions)
    await recordSecretName(name)
    return true
  } catch (err) {
    console.warn('[secrets] write failed', name, (err as Error)?.message)
    return false
  }
}

/** Prompt-free, and works while locked or lost: deleting ciphertext needs no
 * key. This is what makes logout possible for a user whose biometrics changed. */
export async function deleteSecret(name: SecretName): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(envKey(name), envOptions)
    await forgetSecretName(name)
  } catch (err) {
    console.warn('[secrets] delete failed', name, (err as Error)?.message)
  }
}

/**
 * Removes every wrapped secret and the KEK itself, so the next launch reads
 * as a clean install rather than prompting for a wallet that no longer exists.
 *
 * Returns whether the legacy plaintext namespace was actually verified gone.
 * XR-107: sweepLegacyKeys() read-back-verifies its own deletes, so `false`
 * here is real evidence — not a guess — that a mnemonic/recoveredKey/password
 * item survived. The caller (Delete Wallet) must not report success or
 * navigate away as though the wallet were fully erased when this is false;
 * it must fail closed and let the user retry.
 */
export async function deleteAllSecrets(): Promise<boolean> {
  for (const name of SECRET_NAMES) {
    try {
      await SecureStore.deleteItemAsync(envKey(name), envOptions)
    } catch {
      /* best effort: these are ciphertext, and the unconditional destroyKek()
       * below is what actually renders any surviving blob unreadable. */
    }
  }
  // XR-107: a pre-envelope legacy plaintext (mnemonic/recoveredKey/password)
  // is a separate keychain namespace from the envelope above and survives it
  // untouched otherwise, letting a later holder of this device rebuild full
  // spend authority after the user believes "Delete Wallet" erased everything.
  const legacyErased = await sweepLegacyKeys()
  await destroyKek()
  return legacyErased
}
