/**
 * The unverified originator namespace (spec 6.3, 6.5). Dependency-free so the Safari extension
 * bundle, the dispatcher and the permissions layer all agree on one grammar.
 *
 * An unattested origin never reaches the wallet under its own name. It is rewritten to
 * `<hostname>.<grantTag>.unverified.invalid`: the `.invalid` TLD never resolves, so no external
 * input can produce the name, and a fresh grant tag per approval means permissions granted under
 * one approval are not inherited by the next (6.4).
 */
import { GRANT_TAG_PREFIX, GRANT_TAG_RANDOM_CHARS } from './protocol/limits'

export class OriginRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OriginRefused'
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const UNVERIFIED_SUFFIX = '.unverified.invalid'
const GRANT_TAG_RE = new RegExp(`^${GRANT_TAG_PREFIX}[a-z2-7]{${GRANT_TAG_RANDOM_CHARS}}$`)
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** The SDK's originator limit, in bytes. */
export const MAX_ORIGINATOR_BYTES = 250
/** `.` + 11-char tag + `.unverified.invalid` leaves this much for the hostname. */
export const MAX_UNVERIFIED_HOSTNAME_BYTES =
  MAX_ORIGINATOR_BYTES - (1 + (1 + GRANT_TAG_RANDOM_CHARS) + UNVERIFIED_SUFFIX.length)

/**
 * Lowercase LDH labels of 1–63 characters, at most `maxLength` in total, no empty label (so no
 * trailing dot), and a last label that is not purely numeric (which also rules out IPv4 literals).
 */
export function isLdhHostname(host: unknown, maxLength: number): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > maxLength) return false
  const labels = host.split('.')
  for (const l of labels) if (l.length > 63 || !LABEL_RE.test(l)) return false
  return !/^[0-9]+$/.test(labels[labels.length - 1])
}

export function isGrantTag(tag: unknown): tag is string {
  return typeof tag === 'string' && GRANT_TAG_RE.test(tag)
}

/** `g` followed by 10 lowercase base32 characters, from a CSPRNG. */
export function mintGrantTag(): string {
  const bytes = new Uint8Array(GRANT_TAG_RANDOM_CHARS)
  globalThis.crypto.getRandomValues(bytes)
  let out = GRANT_TAG_PREFIX
  // 256 is a multiple of 32, so masking the low five bits is unbiased.
  for (const b of bytes) out += BASE32[b & 31]
  return out
}

export function unverifiedOriginator(hostname: string, grantTag: string): string {
  if (!isGrantTag(grantTag)) throw new OriginRefused('invalid grant tag')
  if (!isLdhHostname(hostname, MAX_UNVERIFIED_HOSTNAME_BYTES) || hostname.split('.').pop() === 'invalid') {
    throw new OriginRefused('hostname cannot be placed in the unverified namespace')
  }
  return `${hostname}.${grantTag}${UNVERIFIED_SUFFIX}`
}

/** Exactly `<hostname>.g<10 base32>.unverified.invalid`, nothing looser. */
export function isUnattestedOriginator(o: unknown): boolean {
  if (typeof o !== 'string' || !o.endsWith(UNVERIFIED_SUFFIX)) return false
  const rest = o.slice(0, -UNVERIFIED_SUFFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot < 1) return false
  const host = rest.slice(0, dot)
  if (!isGrantTag(rest.slice(dot + 1))) return false
  if (!isLdhHostname(host, MAX_UNVERIFIED_HOSTNAME_BYTES)) return false
  return host.split('.').pop() !== 'invalid'
}

export function hostnameOfUnattested(o: string): string {
  if (!isUnattestedOriginator(o)) throw new OriginRefused('not an unverified originator')
  const rest = o.slice(0, -UNVERIFIED_SUFFIX.length)
  return rest.slice(0, rest.lastIndexOf('.'))
}
