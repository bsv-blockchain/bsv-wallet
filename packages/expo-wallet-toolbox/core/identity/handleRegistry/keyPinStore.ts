/**
 * Trust-on-first-use for paymail → identityKey.
 *
 * A profile certificate only proves the subject signed it as its own
 * certifier — it says nothing about who is entitled to a paymail. A registry
 * (any registry, including our pinned one) that turns malicious or is
 * compromised can therefore mint a fresh, self-signed certificate for
 * `victim@domain` under an attacker key, and `verifyProfileCertificate` has
 * no naming authority to check it against (XR-071 / SEC2-079).
 *
 * What we CAN check is continuity: once this device has resolved a key for a
 * paymail, a different key showing up later for the same paymail is either a
 * real, rare re-key or an attack, and the two are indistinguishable from a
 * static check alone — so a later different key is refused rather than
 * silently accepted. This is deliberately per-device, not synced through
 * backup: it protects against what the paymail's OWN registry does after the
 * fact, so it must not be something a compromised backup or that same
 * registry could also rewrite.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'handleRegistry.keyPins.v1'

export interface KeyPinStore {
  /** The identityKey this device has previously accepted for `paymail`, or null. */
  get(paymail: string): Promise<string | null>
  /** Records `identityKey` as the accepted key for `paymail`, if none is pinned yet. */
  set(paymail: string, identityKey: string): Promise<void>
}

let pins: Record<string, string> | null = null

async function load(): Promise<Record<string, string>> {
  if (pins) return pins
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    pins = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    pins = {}
  }
  return pins
}

/** One store, backed by the same on-device AsyncStorage every client instance
 * shares — a paymail resolved from one screen must still be pinned the next
 * time any other screen resolves it. */
export function createKeyPinStore(): KeyPinStore {
  return {
    async get(paymail) {
      const table = await load()
      return table[paymail] ?? null
    },
    async set(paymail, identityKey) {
      const table = await load()
      if (table[paymail] === identityKey) return
      table[paymail] = identityKey
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(table))
      } catch (e) {
        console.warn('[handleRegistry] failed to persist a key pin', e)
      }
    }
  }
}

/** Test-only: forget every pin and the in-memory cache. */
export function resetKeyPinsForTests(): void {
  pins = null
}
