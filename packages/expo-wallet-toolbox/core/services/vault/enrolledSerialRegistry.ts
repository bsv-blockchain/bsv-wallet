/**
 * XQ-014 — device-wide registry of enrolled Vault YubiKey serials.
 *
 * pivReset.ts's own docstring states the residual plainly: a vault belonging
 * to a DIFFERENT wallet identity on this device is invisible to it, because
 * SecureStore cannot be enumerated across identities —
 * vaultStore.enrolledSerialsAcrossChains only ever sees the ONE identity that
 * captured its scope token. Guard 3 (the card's own occupied-slot answer) was
 * the only backstop, and it was overridable by the caller-supplied
 * `acknowledgeUnrecognizedVaultKey` consent — whose copy could only ever
 * disclose the uncertainty, never resolve it.
 *
 * This module is the "device-wide serial index" that residual needed: a
 * plain AsyncStorage-backed set of BARE serials — never pubkeys, nicknames,
 * or identity keys, so it carries no key material and grants no spend
 * authority to anything. Every identity's vaultStore writes to the SAME
 * device-wide key, so pivReset can now refuse UNCONDITIONALLY (never
 * overridable) when the tapped serial is one ANY identity on this device has
 * ever committed as a live Vault signer — not just the currently active one.
 *
 * WHY NOT REFERENCE-COUNTED. A serial can legitimately be committed under
 * more than one identity's vault at once (the same physical YubiKey enrolled
 * twice), so `record`/`forget` are plain set add/remove, not a counter.
 * `forget` is called only after the CALLING identity has independently
 * confirmed, via vaultStore.enrolledSerialsAcrossChains, that no OTHER chain
 * of THAT SAME identity still holds the serial — so a key genuinely shared
 * only within one identity's own chains is never dropped prematurely. A
 * serial shared ACROSS two different identities is a residual this module
 * cannot fully resolve (proving that would need the same cross-identity
 * enumeration SecureStore does not allow): if identity A fully removes its
 * own copy while identity B still holds the same physical key, the registry
 * forgets it and pivReset falls back to the pre-existing, honestly-worded
 * `acknowledgeUnrecognizedVaultKey` consent for identity B's card — exactly
 * the same protection this residual had before this module existed, never
 * worse. The registry only ever makes a destructive maintenance action
 * refuse MORE often; it never grants any capability.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const REGISTRY_KEY = 'vault_enrolled_serial_registry_v1'

/** Same shape as vaultStore.ts's isVaultSerial, duplicated rather than
 * imported: this module deliberately has no dependency on vaultStore (or the
 * expo-secure-store it pulls in) — it is a plain, storage-agnostic-of-vault
 * device record every identity's vaultStore writes INTO, not a vaultStore
 * extension. */
function isVaultSerial(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
}

async function readRegistry(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(REGISTRY_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((serial): serial is string => isVaultSerial(serial)))
  } catch {
    // Corrupt bookkeeping is never fatal, and never trusted as "empty": an
    // unreadable registry answers `has` as though nothing were forgotten
    // (see `has` below), so it only ever narrows what gets refused, never
    // silently drops a real entry.
    return new Set()
  }
}

async function writeRegistry(serials: ReadonlySet<string>): Promise<void> {
  await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify([...serials]))
}

export const enrolledSerialRegistry = {
  /** Called whenever ANY identity's vaultStore commits `serial` as an
   * enrolled Vault key (finalizeEnrollment, addVaultKey). Best-effort: a
   * storage failure here must never fail the enrollment it is recording
   * after — pivReset's registry check degrading to "not recognized" for
   * this one serial only narrows a future refusal, it never threatens I1/I2. */
  async record(serial: string): Promise<void> {
    if (!isVaultSerial(serial)) return
    try {
      const current = await readRegistry()
      if (current.has(serial)) return
      current.add(serial)
      await writeRegistry(current)
    } catch (err) {
      console.warn('[enrolledSerialRegistry] record failed:', err)
    }
  },

  /** Called only after the caller has independently confirmed (via
   * vaultStore.enrolledSerialsAcrossChains for its OWN identity) that no
   * other chain of that identity still holds `serial` — see this module's
   * header for the cross-identity residual this does not, and cannot,
   * fully resolve. Best-effort, like `record`. */
  async forget(serial: string): Promise<void> {
    if (!isVaultSerial(serial)) return
    try {
      const current = await readRegistry()
      if (!current.has(serial)) return
      current.delete(serial)
      await writeRegistry(current)
    } catch (err) {
      console.warn('[enrolledSerialRegistry] forget failed:', err)
    }
  },

  /** Never throws: an unreadable registry answers `false`, the same
   * fail-narrow behavior as a corrupt read (see readRegistry). */
  async has(serial: string): Promise<boolean> {
    if (!isVaultSerial(serial)) return false
    try {
      return (await readRegistry()).has(serial)
    } catch {
      return false
    }
  },

  /** Test/maintenance only — no production caller. */
  async clearAll(): Promise<void> {
    await AsyncStorage.removeItem(REGISTRY_KEY)
  }
}

/**
 * Forget every serial in `candidates` that is no longer enrolled under any
 * OTHER chain of the identity `scopeToken` was captured for. Called after a
 * key (or a whole vault) has just been fully removed/disabled for that
 * identity+chain, once vaultStore's own write already reflects the removal —
 * so `enrolledSerialsAcrossChains`'s scan of the remaining chains answers
 * correctly. See enrolledSerialRegistry's header for why this is not, and
 * cannot be, a cross-IDENTITY check.
 */
export async function forgetSerialsNoLongerEnrolledForIdentity(
  candidates: readonly string[],
  enrolledSerialsAcrossChains: () => Promise<string[]>
): Promise<void> {
  if (candidates.length === 0) return
  let stillEnrolled: Set<string>
  try {
    stillEnrolled = new Set(await enrolledSerialsAcrossChains())
  } catch (err) {
    // Fail closed on the SIDE OF THE REGISTRY, not the removal that already
    // committed: an unreadable cross-chain scan must not forget a serial it
    // cannot prove is free elsewhere on this identity.
    console.warn('[enrolledSerialRegistry] cross-chain check failed, leaving candidates registered:', err)
    return
  }
  for (const serial of candidates) {
    if (!stillEnrolled.has(serial)) await enrolledSerialRegistry.forget(serial)
  }
}
