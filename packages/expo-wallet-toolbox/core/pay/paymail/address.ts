/**
 * Paymail address rules shared by the send path and the outbox import check.
 *
 * The alias follows the bsvalias grammar (letters, digits, `-`, `_`, `.`), so
 * it may start with `_`, `.` or `-`. `+` is accepted after the first character
 * for sub-addressing. `/`, `?`, `#`, whitespace and `@` are never allowed; the
 * alias is also URL-encoded when a capability template is filled.
 */
import { looksLikeDomain } from '../../identity/handleRegistry/rules'

export const ALIAS_FORMAT = /^[a-z0-9._-][a-z0-9._+-]{0,63}$/

/** The lowercased alias and domain, or null when this is not a paymail. */
export function parsePaymail(paymail: string): { alias: string; domain: string } | null {
  if (typeof paymail !== 'string') return null
  const parts = paymail.trim().toLowerCase().split('@')
  if (parts.length !== 2 || !ALIAS_FORMAT.test(parts[0]) || !looksLikeDomain(parts[1])) return null
  return { alias: parts[0], domain: parts[1] }
}
