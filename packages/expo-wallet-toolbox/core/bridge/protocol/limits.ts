/**
 * Bridge limits (spec 6.6, 6.7, 6.8, 6.4). Pure constants so every layer, and the
 * Safari extension bundle, agrees on one set of numbers.
 */

/** Largest single bridge request body. */
export const MAX_BRIDGE_REQUEST_BYTES = 5 * 1024 * 1024
/** Concurrent requests per binding. */
export const MAX_IN_FLIGHT_PER_BINDING = 4
/** Concurrent requests across all bindings. */
export const MAX_IN_FLIGHT_TOTAL = 16
/** Request bytes in flight across all bindings. */
export const MAX_IN_FLIGHT_BYTES = 5 * 1024 * 1024

/** Live bindings per origin. */
export const MAX_BINDINGS_PER_ORIGIN = 8
/** Live bindings overall. */
export const MAX_BINDINGS_TOTAL = 64
/** Tombstone ring capacity and age. */
export const TOMBSTONE_RING_SIZE = 1024
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

/** Durable inbox: longest `notAfter - createdAt`, accepted clock skew, result retention. */
export const INBOX_MAX_VALIDITY_MS = 15 * 60 * 1000
export const INBOX_CLOCK_SKEW_MS = 5 * 60 * 1000
export const INBOX_RESULT_TTL_MS = 15 * 60 * 1000

/** After a decline the same site is not asked again for this long. */
export const DECLINE_BACKOFF_MS = 30 * 1000
/** Taps on an approval control are ignored for this long after it appears. */
export const TAP_PROTECTION_MS = 700

/** Grant tag: `g` followed by this many lowercase base32 characters. */
export const GRANT_TAG_PREFIX = 'g'
export const GRANT_TAG_RANDOM_CHARS = 10

/** Reconnect token: random bytes, sent as base64url, stored as a SHA-256 hash. */
export const RECONNECT_TOKEN_BYTES = 32

/** BRC-185 section 3: describe and connect responses are bounded. */
export const MAX_PROOF_RESPONSE_BYTES = 16384
/** BRC-185 section 3: challenge is 32 random bytes. */
export const CHALLENGE_BYTES = 32
