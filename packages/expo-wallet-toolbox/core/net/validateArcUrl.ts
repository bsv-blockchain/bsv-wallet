/**
 * XR-064: a custom ARC broadcast endpoint carries the signed transaction (and
 * any configured API token) over the wire. Restrict it to https, with a
 * narrow explicit exception for local development against a loopback
 * broadcaster (http://localhost / http://127.0.0.1) — so an on-path
 * attacker on a person-chosen plaintext host cannot observe the transaction
 * and callback token, or return a bare success that suppresses the real
 * HTTPS fallback chain, while the legitimate local-dev workflow keeps
 * working.
 */
export function validateArcUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return true // empty clears the override back to the default
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
}
