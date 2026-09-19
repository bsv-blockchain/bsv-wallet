/**
 * What a background refresh should write to a contact's cache columns.
 *
 * `refreshContactCache` replaces all three in one UPDATE — that is what keeps
 * it a single statement and keeps `name` untouchable — so a caller that names
 * only the avatar silently blanks the handle stored beside it. This decides
 * the COMPLETE row instead, from what the contact already had and what this
 * pass actually learned.
 *
 * An absent learned value means "not looked up this time" and keeps what is
 * there; an EMPTY one means "looked, and there is none" and clears it. That
 * distinction is the whole reason this is a function and not a spread: a
 * registry 404 has to be able to remove a handle the contact no longer holds.
 */
export interface ContactCache {
  cachedHandle?: string
  cachedAvatarUrl?: string
  cachedCertifier?: string
}

function pick(current: string | undefined, learned: string | undefined): string | undefined {
  if (learned === undefined) return current
  return learned === '' ? undefined : learned
}

/** The row to write, or null when this pass learned nothing new. */
export function mergeContactCache(
  current: ContactCache,
  learned: { cachedHandle?: string; cachedAvatarUrl?: string }
): ContactCache | null {
  const merged: ContactCache = {
    cachedHandle: pick(current.cachedHandle, learned.cachedHandle),
    cachedAvatarUrl: pick(current.cachedAvatarUrl, learned.cachedAvatarUrl),
    cachedCertifier: current.cachedCertifier
  }
  const unchanged =
    merged.cachedHandle === current.cachedHandle &&
    merged.cachedAvatarUrl === current.cachedAvatarUrl &&
    merged.cachedCertifier === current.cachedCertifier
  return unchanged ? null : merged
}
