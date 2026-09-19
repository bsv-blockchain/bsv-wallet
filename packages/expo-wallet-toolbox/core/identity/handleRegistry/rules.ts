/**
 * Handle-registry rules — the constants, and the string checks that are pure.
 *
 * Every value here mirrors a rule the registry enforces on write
 * (go-message-box-server `pkg/handles`, `pkg/profilecert`). Restating them on
 * this side is not distrust of the server: a client that cannot tell a valid
 * handle from an invalid one has to ask the network what the user just typed,
 * once per keystroke.
 *
 * "Handle" already names the identity-key pay rail in this codebase
 * (`RailId 'handle'`, core/pay/rails/handle.ts). Nothing here reuses that word
 * as a rail — a handle is the local part of a `handle@domain` paymail.
 */
import { Utils } from '@bsv/sdk'

/** base64(SHA-256("public profile lookup")) — the profile certificate's type. */
export const PROFILE_CERT_TYPE = 'SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE='
/** BRFC id of the `public profile lookup` capability — search. */
export const BRFC_LOOKUP = '0ace65da5987'
/** BRFC id of the `public profile reverse lookup` capability — key → profile. */
export const BRFC_REVERSE_LOOKUP = '43dcf83ddc5f'
/** There is no on-chain revocation: a profile is replaced or tombstoned. */
export const ZERO_OUTPOINT = `${'0'.repeat(64)}.0`

export const MAX_FIELDS = 32
/** Exclusive — go-sdk's own `CertificateFieldNameUnder50Bytes`. */
export const MAX_FIELD_NAME_BYTES = 50
export const MAX_FIELD_VALUE_BYTES = 1024
export const MAX_CERT_BODY_BYTES = 16384

/** Shorter than this and the search route answers nothing at all. */
export const SEARCH_MIN_QUERY_LENGTH = 2
/** Longer than this and the search route answers nothing at all. */
export const MAX_SEARCH_QUERY_LENGTH = 32

const HANDLE_FORMAT = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/
const DOMAIN_FORMAT = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const SEARCH_QUERY_FORMAT = /^[a-z0-9._-]+$/

/**
 * Path segments a query must never become, because the search route never sees
 * them. `GET /api/handle/available` is mounted ahead of
 * `GET /api/handle/{query}` and answers `400 ERR_INVALID_LOOKUP`; `..` does not
 * even leave the device intact, since the URL parser collapses a double-dot
 * segment (`https://host/api/handle/..` is `https://host/api/`, which nothing
 * serves) and encoding cannot rescue it — the spec reads `%2e%2e` as the same
 * segment. Either one `search` would surface as "the registry is down", for an
 * ordinary English word or for two dots. A lone `.` is already too short.
 */
const RESERVED_QUERY_PATHS = new Set(['available', '..'])

/** 3-32 characters of a-z 0-9 . _ - beginning and ending with a letter or digit. */
export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_FORMAT.test(handle)
}

/** A dotted, all-lowercase domain. Says nothing about whether it resolves. */
export function looksLikeDomain(text: string): boolean {
  return DOMAIN_FORMAT.test(text.trim().toLowerCase())
}

/**
 * Whether the registry would actually search for this, rather than answer an
 * empty array or a 400. Restating the server's own gate here is what keeps a
 * routine word — a too-long paste, an accent, a slash — from costing a request
 * and, for the reserved paths, from raising an outage banner.
 */
export function isRoutableSearchQuery(query: string): boolean {
  if (query.length < SEARCH_MIN_QUERY_LENGTH || query.length > MAX_SEARCH_QUERY_LENGTH) return false
  if (!SEARCH_QUERY_FORMAT.test(query)) return false
  return !RESERVED_QUERY_PATHS.has(query)
}

/**
 * `handle@domain`, trimmed and lowercased, or null when it is not one.
 *
 * Lowercasing here is what makes a typed `Dee@Example.com` comparable with the
 * exact-lowercase `paymail` field the registry stores — the comparison the
 * trust model turns on.
 */
export function parsePaymail(text: string): { handle: string; domain: string } | null {
  const parts = text.trim().toLowerCase().split('@')
  if (parts.length !== 2) return null
  const [handle, domain] = parts
  if (!isValidHandleFormat(handle) || !looksLikeDomain(domain)) return null
  return { handle, domain }
}

/** UTF-8 length, the unit every server-side size limit counts in. `Buffer` does
 * not exist in React Native, so this goes through the SDK's own encoder. */
export function utf8ByteLength(text: string): number {
  return Utils.toArray(text, 'utf8').length
}
