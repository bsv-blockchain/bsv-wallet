const BINARY_ENCODING = 'base64'
const TAG = '$bsvBinary'
const ESCAPED = 'escaped'

type TaggedBinary = { [TAG]: typeof BINARY_ENCODING; data: string }
type EscapedJson = { [TAG]: typeof ESCAPED; entries: Array<[string, unknown]> }

function isTaggedBinary(value: unknown): value is TaggedBinary {
  return value != null && typeof value === 'object' &&
    (value as Record<string, unknown>)[TAG] === BINARY_ENCODING &&
    typeof (value as Record<string, unknown>).data === 'string' &&
    Object.keys(value).length === 2
}

function isBufferJson(value: unknown): value is { type: 'Buffer'; data: number[] } {
  return value != null && typeof value === 'object' &&
    (value as Record<string, unknown>).type === 'Buffer' &&
    Array.isArray((value as Record<string, unknown>).data) &&
    Object.keys(value).length === 2
}

function isEscapedJson(value: unknown): value is EscapedJson {
  const candidate = value as Partial<EscapedJson> | null
  return candidate != null && typeof candidate === 'object' &&
    candidate[TAG] === ESCAPED && Array.isArray(candidate.entries) &&
    Object.keys(candidate).length === 2 &&
    candidate.entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string')
}

function escapeJsonObject(value: object): EscapedJson {
  return { [TAG]: ESCAPED, entries: Object.entries(value) }
}

function toBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === 'function') {
    let binary = ''
    const chunkSize = 32_768
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCodePoint(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
    }
    return globalThis.btoa(binary)
  }
  throw new Error('This runtime does not provide base64 encoding')
}

function fromBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Invalid base64 binary JSON value')
  }
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(value)
    return Uint8Array.from(binary, character => character.codePointAt(0) ?? 0)
  }
  throw new Error('This runtime does not provide base64 decoding')
}

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { [TAG]: BINARY_ENCODING, data: toBase64(value) }
  if (value == null || typeof value !== 'object') return value
  if (isBufferJson(value)) {
    const original = this[key]
    if (original instanceof Uint8Array) return { [TAG]: BINARY_ENCODING, data: toBase64(original) }
    return escapeJsonObject(value)
  }
  if (isTaggedBinary(value) || isEscapedJson(value)) return escapeJsonObject(value)
  return value
}

function reviver(_key: string, value: unknown): unknown {
  if (isTaggedBinary(value)) return fromBase64(value.data)
  if (isEscapedJson(value)) return Object.fromEntries(value.entries)
  return value
}

export function stringifyJsonRpc(value: unknown, binary: boolean): string {
  return JSON.stringify(value, binary ? replacer : (_key, item) => item instanceof Uint8Array ? Array.from(item) : item)
}

export function parseJsonRpc(text: string, binary = false): unknown {
  return JSON.parse(text, binary ? reviver : undefined)
}
