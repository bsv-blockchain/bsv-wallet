/**
 * Connection-layer errors the extension raises itself (BRC-185 section 6). Pure; the shape is P1's
 * `ConnectionError`, so the page-world proxy rejects with it unchanged (spec 6.8 (d)).
 */
import {
  connectionError,
  isConnectionError,
  type ConnectionError,
  type ConnectionErrorCode,
  type Delivery
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'

export { connectionError, isConnectionError }
export type { ConnectionError, ConnectionErrorCode, Delivery }

/** The wallet never saw the call. */
export const notSent = (code: ConnectionErrorCode, message: string, cause?: string): ConnectionError =>
  connectionError(code, message, 'not-sent', cause === undefined ? {} : { cause })

/** The call may have run. */
export const unknownDelivery = (code: ConnectionErrorCode, message: string, cause?: string): ConnectionError =>
  connectionError(code, message, 'unknown', cause === undefined ? {} : { cause })

export const protocolError = (message: string): ConnectionError => notSent('PROTOCOL_ERROR', message)
export const configurationError = (message: string, cause?: string): ConnectionError =>
  notSent('CONFIGURATION_ERROR', message, cause)
export const resourceLimit = (message: string): ConnectionError => notSent('RESOURCE_LIMIT', message)

/** Anything thrown becomes a ConnectionError; a ConnectionError passes through untouched. */
export function asConnectionError(e: unknown, fallback: () => ConnectionError): ConnectionError {
  return isConnectionError(e) ? e : fallback()
}
