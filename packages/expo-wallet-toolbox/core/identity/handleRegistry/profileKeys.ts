/**
 * Where a wallet keeps its own profile on this device (its storage key-value
 * table). Shared so every host that registers a handle (Profile, a host's own
 * onboarding) reads and writes the same entries.
 */

/** The full `handle@domain`, cached for a cold start. The registry decides. */
export const HANDLE_KV_KEY = 'profile_registered_handle'

/**
 * The display name lives here on this device, and — once a handle is
 * registered — as a PUBLIC plaintext field of the profile certificate
 * (2026-09-18 ruling). The identity overlay's `name` is only a fallback for a
 * wallet that has never set one.
 */
export const DISPLAY_NAME_KV_KEY = 'profile_display_name'
