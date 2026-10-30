/** Byte helpers for staging and pickup. Pure; `@bsv/sdk` is already in the bundle for describe. */
import { Hash, Utils } from '@bsv/sdk'

export const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
/** Standard alphabet, padded: the wire form of every `bytes` field (spec 6.11). */
export const toBase64 = (b: Uint8Array): string => Utils.toBase64(Array.from(b))
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(Utils.toArray(s, 'base64'))
/** Lowercase hex, 64 characters: what the appex compares at `stageEnd`. */
export const sha256Hex = (b: Uint8Array): string => Utils.toHex(Hash.sha256(Array.from(b)))
