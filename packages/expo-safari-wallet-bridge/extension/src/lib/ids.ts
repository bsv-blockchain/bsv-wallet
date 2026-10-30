/** Random identifiers. Pure: only `crypto.getRandomValues`, present in WebKit and in jest. */
import { isUuidV4 } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'

export { isUuidV4 }

const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/** Lowercase UUIDv4. */
export function uuidv4(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = hex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const randomHex = (n: number): string => hex(randomBytes(n))
