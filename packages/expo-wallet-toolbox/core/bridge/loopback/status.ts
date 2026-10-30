/** The HTTP status table (spec 6.6.2). Pages discriminate by body; statuses are for logs and generic clients. */
import type { ConnectionError } from '../protocol/connectionError'

export const STATUS = Object.freeze({
  ok: 200,
  noContent: 204,
  walletError: 400,
  protocolError: 400,
  notFound: 404,
  forbidden: 403,
  userCancelled: 403,
  launchProof: 403,
  methodNotAllowed: 405,
  providerChanged: 412,
  connectionClosed: 410,
  lengthRequired: 411,
  bodyTooLarge: 413,
  unsupportedMediaType: 415,
  resourceLimit: 429,
  notBuilt: 503,
  tooManyConnections: 503,
  oversizeResponse: 502,
  internal: 500
} as const)

export type StatusKey = keyof typeof STATUS

/**
 * The status for a connection error. The code decides unless the caller names a `situation` that the code alone
 * cannot express (launch proof refusal, oversize response, internal error, oversize request).
 */
export function statusForConnectionError(e: ConnectionError, situation?: StatusKey): number {
  if (situation !== undefined) return STATUS[situation]
  switch (e.code) {
    case 'PROTOCOL_ERROR':
      return STATUS.protocolError
    case 'PROVIDER_CHANGED':
      return STATUS.providerChanged
    case 'CONNECTION_CLOSED':
      return STATUS.connectionClosed
    case 'RESOURCE_LIMIT':
      return STATUS.resourceLimit
    case 'USER_CANCELLED':
      return STATUS.userCancelled
    case 'CONFIGURATION_ERROR':
      return STATUS.notBuilt
    default:
      // Page-side codes (SELECTION_REQUIRED, DISCOVERY_BLOCKED, PAIRING_*, DISCONNECTED) are never emitted by the
      // server; if one reaches here it is an internal error.
      return STATUS.internal
  }
}
