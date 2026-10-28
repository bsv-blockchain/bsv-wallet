/** BRC-185 section 6 connection errors and the outcome table that assigns them (spec 6.11). */
/** Cut to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
    if (bytes + n > maxBytes) break
    bytes += n
    out += ch
  }
  return out
}

export type ConnectionErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'SELECTION_REQUIRED'
  | 'USER_CANCELLED'
  | 'DISCOVERY_BLOCKED'
  | 'PROVIDER_CHANGED'
  | 'PAIRING_EXPIRED'
  | 'PAIRING_REJECTED'
  | 'PROTOCOL_ERROR'
  | 'RESOURCE_LIMIT'
  | 'DISCONNECTED'
  | 'CONNECTION_CLOSED'

/** `not-sent`: the wallet never saw the call. `unknown`: it may have run. */
export type Delivery = 'not-sent' | 'unknown'

export interface ConnectionError {
  domain: 'brc185'
  code: ConnectionErrorCode
  message: string
  delivery: Delivery
  epoch?: string
  cause?: string
}

export const CONNECTION_ERROR_CODES: readonly ConnectionErrorCode[] = Object.freeze([
  'CONFIGURATION_ERROR',
  'SELECTION_REQUIRED',
  'USER_CANCELLED',
  'DISCOVERY_BLOCKED',
  'PROVIDER_CHANGED',
  'PAIRING_EXPIRED',
  'PAIRING_REJECTED',
  'PROTOCOL_ERROR',
  'RESOURCE_LIMIT',
  'DISCONNECTED',
  'CONNECTION_CLOSED'
])

export function connectionError(
  code: ConnectionErrorCode,
  message: string,
  delivery: Delivery,
  extra: { epoch?: string; cause?: string } = {}
): ConnectionError {
  const e: ConnectionError = { domain: 'brc185', code, message: truncateUtf8(String(message), 4096), delivery }
  if (extra.epoch !== undefined) e.epoch = extra.epoch
  if (extra.cause !== undefined) e.cause = extra.cause
  return e
}

export function isConnectionError(v: unknown): v is ConnectionError {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o.domain === 'brc185' &&
    typeof o.message === 'string' &&
    (o.delivery === 'not-sent' || o.delivery === 'unknown') &&
    CONNECTION_ERROR_CODES.includes(o.code as ConnectionErrorCode)
  )
}
