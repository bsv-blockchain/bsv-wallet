/**
 * Canonical unpadded base64url (RFC 4648 section 5). The decoder is strict: any input
 * that would not be produced by `b64uEncode` for the same bytes is rejected, so a value
 * has exactly one spelling (BRC-185 section 3). No Buffer/atob: bundle-safe everywhere.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i

export class Base64urlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Base64urlError'
  }
}

export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63]
  }
  return out
}

export function b64uDecode(s: string): Uint8Array {
  if (typeof s !== 'string') throw new Base64urlError('base64url input must be a string')
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] in LOOKUP)) throw new Base64urlError('base64url contains a character outside the alphabet')
  }
  const rem = s.length % 4
  if (rem === 1) throw new Base64urlError('base64url has an impossible length')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  let i = 0
  for (; i + 3 < s.length; i += 4) {
    const n = (LOOKUP[s[i]] << 18) | (LOOKUP[s[i + 1]] << 12) | (LOOKUP[s[i + 2]] << 6) | LOOKUP[s[i + 3]]
    out[o++] = (n >> 16) & 255
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  if (rem === 2) {
    const n = (LOOKUP[s[i]] << 18) | (LOOKUP[s[i + 1]] << 12)
    // The last character carries 4 payload bits and 4 trailing bits that must be zero.
    if ((n & 0xffff) !== 0) throw new Base64urlError('base64url has non-zero trailing bits')
    out[o++] = (n >> 16) & 255
  } else if (rem === 3) {
    const n = (LOOKUP[s[i]] << 18) | (LOOKUP[s[i + 1]] << 12) | (LOOKUP[s[i + 2]] << 6)
    if ((n & 0xff) !== 0) throw new Base64urlError('base64url has non-zero trailing bits')
    out[o++] = (n >> 16) & 255
    out[o++] = (n >> 8) & 255
  }
  return out
}
