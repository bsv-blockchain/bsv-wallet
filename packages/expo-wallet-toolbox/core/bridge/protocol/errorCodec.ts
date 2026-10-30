/**
 * Wallet error <-> BRC-100 wire error (spec 6.11). Pure TS, usable page-side and wallet-side.
 *
 * Mapping is by `instanceof` for SDK classes, by numeric `code`, by toolbox `name`, and by string
 * `code` for HMAC/signature failures. It never goes by the truthiness of `code`: toolbox errors
 * expose `code` as a string getter that returns the `WERR_*` name.
 */
import { WERR_INSUFFICIENT_FUNDS, WERR_INVALID_PARAMETER, WERR_REVIEW_ACTIONS } from '@bsv/sdk'
import { isConnectionError, truncateUtf8 } from './connectionError'

export const MAX_ERROR_MESSAGE_BYTES = 4096

export interface WireError {
  isError: true
  code: number
  name: string
  message: string
  data: { originalName?: string; originalCode?: number | string }
  [field: string]: unknown
}

type Loose = Record<string, unknown>

const PARAM_NAMES = new Set(['WERR_INVALID_PARAMETER', 'VaultAccessDenied', 'WalletArgTooLarge'])
const WIRE_NAME: Record<number, string> = {
  1: 'WERR_UNKNOWN',
  3: 'ERR_INVALID_HMAC',
  4: 'ERR_INVALID_SIGNATURE',
  5: 'WERR_REVIEW_ACTIONS',
  6: 'WERR_INVALID_PARAMETER',
  7: 'WERR_INSUFFICIENT_FUNDS'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function encodeWalletError(e: unknown): WireError {
  const o: Loose = typeof e === 'object' && e !== null ? (e as Loose) : {}
  const originalName = str(o.name)
  const rawCode = o.code
  const message = truncateUtf8(
    str(o.message) ?? (typeof e === 'string' ? e : 'Wallet call failed'),
    MAX_ERROR_MESSAGE_BYTES
  )
  const data: WireError['data'] = {}
  if (originalName !== undefined) data.originalName = originalName
  if (typeof rawCode === 'number' || typeof rawCode === 'string') data.originalCode = rawCode

  const wire = (code: number, fields: Loose = {}): WireError => ({
    ...fields,
    isError: true,
    code,
    name: WIRE_NAME[code],
    message,
    data
  })

  if (e instanceof WERR_REVIEW_ACTIONS || originalName === 'WERR_REVIEW_ACTIONS' || rawCode === 5) {
    const f: Loose = { reviewActionResults: arr(o.reviewActionResults), sendWithResults: arr(o.sendWithResults) }
    if (str(o.txid) !== undefined) f.txid = o.txid
    if (o.tx instanceof Uint8Array) f.tx = Array.from(o.tx)
    else if (Array.isArray(o.tx)) f.tx = o.tx
    if (Array.isArray(o.noSendChange)) f.noSendChange = o.noSendChange
    return wire(5, f)
  }
  if (
    e instanceof WERR_INVALID_PARAMETER ||
    (originalName !== undefined && PARAM_NAMES.has(originalName)) ||
    rawCode === 6
  ) {
    // SDK clients require `parameter`; errors that carry only `field` (or nothing) get one.
    return wire(6, { parameter: str(o.parameter) || str(o.field) || 'request' })
  }
  if (e instanceof WERR_INSUFFICIENT_FUNDS || originalName === 'WERR_INSUFFICIENT_FUNDS' || rawCode === 7) {
    return wire(7, { totalSatoshisNeeded: num(o.totalSatoshisNeeded), moreSatoshisNeeded: num(o.moreSatoshisNeeded) })
  }
  if (rawCode === 'ERR_INVALID_HMAC') return wire(3)
  if (rawCode === 'ERR_INVALID_SIGNATURE') return wire(4)
  // WERR_INVALID_MERKLE_ROOT, user denial and everything else: 1, message only, never a stack.
  return wire(1)
}

function plain(w: Loose, message: string, code: number | string): Error {
  const e = new Error(message) as Error & Loose
  const name = str(w.name)
  e.name = name !== undefined && name.length > 0 && name.length <= 100 ? name : 'Error'
  e.isError = true
  e.code = code
  return e
}

/** Rebuild an `Error` from a wire error or a ConnectionError, with the SDK's bounds on fields. */
export function decodeWireError(w: unknown): Error {
  if (typeof w !== 'object' || w === null)
    return plain({}, typeof w === 'string' ? truncateUtf8(w, MAX_ERROR_MESSAGE_BYTES) : 'Wallet call failed', 1)
  const o = w as Loose
  if (isConnectionError(o)) {
    const e = new Error(o.message) as Error & Loose
    e.name = 'ConnectionError'
    e.domain = o.domain
    e.code = o.code
    e.delivery = o.delivery
    if (o.epoch !== undefined) e.epoch = o.epoch
    if (o.cause !== undefined) e.cause = o.cause
    return e
  }
  const message = truncateUtf8(str(o.message) ?? 'Wallet call failed', MAX_ERROR_MESSAGE_BYTES)
  switch (o.code) {
    case 5: {
      const { reviewActionResults: r, sendWithResults: s, txid, tx, noSendChange: n } = o
      const okTx = tx === undefined || (Array.isArray(tx) && tx.every(b => Number.isInteger(b) && b >= 0 && b <= 255))
      const okN = n === undefined || (Array.isArray(n) && n.every(x => typeof x === 'string'))
      if (Array.isArray(r) && Array.isArray(s) && (txid === undefined || typeof txid === 'string') && okTx && okN) {
        const e = new WERR_REVIEW_ACTIONS(
          r as never,
          s as never,
          txid as string | undefined,
          tx as number[] | undefined,
          n as string[] | undefined
        )
        e.message = message
        return e
      }
      break
    }
    case 6: {
      const p = o.parameter
      if (typeof p === 'string' && p.length > 0 && p.length <= 250) {
        const e = new WERR_INVALID_PARAMETER(p)
        e.message = message
        return e
      }
      break
    }
    case 7: {
      const { totalSatoshisNeeded: t, moreSatoshisNeeded: m } = o
      if (
        typeof t === 'number' &&
        typeof m === 'number' &&
        Number.isFinite(t) &&
        Number.isFinite(m) &&
        t >= 0 &&
        m >= 0
      ) {
        const e = new WERR_INSUFFICIENT_FUNDS(t, m)
        e.message = message
        return e
      }
      break
    }
    case 3:
      return plain(o, message, 'ERR_INVALID_HMAC')
    case 4:
      return plain(o, message, 'ERR_INVALID_SIGNATURE')
  }
  return plain(o, message, typeof o.code === 'number' && Number.isInteger(o.code) ? o.code : 1)
}
