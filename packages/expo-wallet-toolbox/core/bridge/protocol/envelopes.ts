/**
 * Wire shapes shared by every bridge layer (spec 6.8, 6.10): BRC-185 `brc185:*` XDM envelopes,
 * and the durable inbox's records, results and close events. Types plus strict structural
 * validators; no behaviour. Project 3's ts-stack side must reproduce the fixtures built from
 * these shapes.
 */
import type { ConnectionError } from './connectionError'
import type { WireError } from './errorCodec'

/** BRC-185 section 4: why an epoch closed, as seen by a page. */
export type CloseReason = 'account-changed' | 'revoked' | 'lost'
/** Internal close reasons add `disconnected`, which is never sent to the page that asked. */
export type InternalCloseReason = CloseReason | 'disconnected'

export const BRC185_VERSION = 1

export interface XdmConnect {
  type: 'brc185:connect'
  version: 1
  instanceId: string
  continuityKey: string
  epoch: string
  challenge: string
}
export interface XdmConnected {
  type: 'brc185:connected'
  version: 1
  proof: unknown
}
export interface XdmConnectionError {
  type: 'brc185:connection-error'
  version: 1
  epoch: string
  error: ConnectionError
}
export interface XdmInvoke {
  type: 'brc185:invoke'
  version: 1
  instanceId: string
  epoch: string
  id: string
  method: string
  params: unknown
}
export interface XdmResult {
  type: 'brc185:result'
  version: 1
  instanceId: string
  epoch: string
  id: string
  result: unknown
}
export interface XdmError {
  type: 'brc185:error'
  version: 1
  instanceId: string
  epoch: string
  id: string
  error: WireError | ConnectionError
}
export interface XdmClosed {
  type: 'brc185:closed'
  version: 1
  instanceId: string
  epoch: string
  reason: CloseReason
}
export type XdmEnvelope = XdmConnect | XdmConnected | XdmConnectionError | XdmInvoke | XdmResult | XdmError | XdmClosed

/** Durable inbox (6.8). There is no `attestation` field: trust comes from the registered transport. */
export interface InboxRecord {
  v: 1
  id: string
  kind: 'invoke' | 'disconnect'
  epoch: string
  instanceId: string
  continuityKey: string
  origin: string
  accountContext: string
  walletRevision: string
  boundAt: number
  method?: string
  args?: unknown
  createdAt: number
  notAfter: number
}

export type InboxResult =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: WireError | ConnectionError }

/**
 * Epoch-specific close event in the store's outbox; `closeSeq` is monotonic. A page-initiated
 * `disconnect` is written too (reason `lost`) with `notifyPage: false`: it is a close, but the
 * page that asked is not told, so the reader must not emit `brc185:closed` for it.
 */
export interface InboxCloseEvent {
  v: 1
  closeSeq: number
  instanceId: string
  epoch: string
  reason: CloseReason
  notifyPage?: false
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CLOSE_REASONS: readonly string[] = ['account-changed', 'revoked', 'lost']

export function isUuidV4(v: unknown): v is string {
  return typeof v === 'string' && UUID_V4.test(v)
}
export function isCloseReason(v: unknown): v is CloseReason {
  return typeof v === 'string' && CLOSE_REASONS.includes(v)
}

function hasExactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(o)
  return have.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))
}

/**
 * Structural check of an incoming XDM envelope. Returns the envelope or undefined: routing fields
 * must be UUIDv4 strings, `version` must be 1, the key set must match exactly (so `result` and
 * `error` stay mutually exclusive), and the type must be a known `brc185:*`. Unknown types are
 * not envelopes of ours and are left to the legacy CWI path.
 */
export function parseXdmEnvelope(v: unknown): XdmEnvelope | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (o.version !== BRC185_VERSION) return undefined
  const routing = (...names: string[]) => names.every(n => isUuidV4(o[n]))
  switch (o.type) {
    case 'brc185:connect':
      return hasExactKeys(o, ['type', 'version', 'instanceId', 'continuityKey', 'epoch', 'challenge']) &&
        routing('epoch') &&
        typeof o.instanceId === 'string' &&
        typeof o.continuityKey === 'string' &&
        typeof o.challenge === 'string'
        ? (o as unknown as XdmConnect)
        : undefined
    case 'brc185:connected':
      return hasExactKeys(o, ['type', 'version', 'proof']) ? (o as unknown as XdmConnected) : undefined
    case 'brc185:connection-error':
      return hasExactKeys(o, ['type', 'version', 'epoch', 'error']) && routing('epoch')
        ? (o as unknown as XdmConnectionError)
        : undefined
    case 'brc185:invoke':
      return hasExactKeys(o, ['type', 'version', 'instanceId', 'epoch', 'id', 'method', 'params']) &&
        routing('epoch', 'id') &&
        typeof o.instanceId === 'string' &&
        typeof o.method === 'string'
        ? (o as unknown as XdmInvoke)
        : undefined
    case 'brc185:result':
      return hasExactKeys(o, ['type', 'version', 'instanceId', 'epoch', 'id', 'result']) &&
        routing('epoch', 'id') &&
        typeof o.instanceId === 'string'
        ? (o as unknown as XdmResult)
        : undefined
    case 'brc185:error':
      return hasExactKeys(o, ['type', 'version', 'instanceId', 'epoch', 'id', 'error']) &&
        routing('epoch', 'id') &&
        typeof o.instanceId === 'string' &&
        typeof o.error === 'object' &&
        o.error !== null
        ? (o as unknown as XdmError)
        : undefined
    case 'brc185:closed':
      return hasExactKeys(o, ['type', 'version', 'instanceId', 'epoch', 'reason']) &&
        routing('epoch') &&
        typeof o.instanceId === 'string' &&
        isCloseReason(o.reason)
        ? (o as unknown as XdmClosed)
        : undefined
    default:
      return undefined
  }
}

export function xdmResult(instanceId: string, epoch: string, id: string, result: unknown): XdmResult {
  return { type: 'brc185:result', version: 1, instanceId, epoch, id, result }
}
export function xdmError(instanceId: string, epoch: string, id: string, error: WireError | ConnectionError): XdmError {
  return { type: 'brc185:error', version: 1, instanceId, epoch, id, error }
}
export function xdmClosed(instanceId: string, epoch: string, reason: CloseReason): XdmClosed {
  return { type: 'brc185:closed', version: 1, instanceId, epoch, reason }
}
