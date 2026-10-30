/**
 * The page-client contract a transport's stand-in client implements (BRC-185 section 4.2, spec 6.16): discover,
 * connect, invoke. Types only, copied from the iOS kit's `src/testing/pageClient.ts` with one change:
 * `DiscoveredProvider.handle` is `unknown`, because the handle is transport-specific (a page-side announce handle on
 * Safari, an endpoint set on Android loopback). The iOS copy is left as is. No imports from the app.
 */
import type { WalletInterface } from '@bsv/sdk'
import { isConnectionError, type ConnectionError, type ConnectionErrorCode } from '../protocol/connectionError'
import type { Descriptor } from '../protocol/descriptor'
import type { CloseReason } from '../protocol/envelopes'

export { isConnectionError }
export type { ConnectionError, ConnectionErrorCode, CloseReason }

export interface DiscoveredProvider {
  requestId: string
  /** Transport-specific; opaque to shared code. */
  handle: unknown
  descriptor: Descriptor
}

export interface RejectedProvider {
  requestId: string
  reason: string
  error?: unknown
}

export interface Connection {
  epoch: string
  provider: DiscoveredProvider
  wallet: WalletInterface
  /** Reasons delivered to `onClose`, in order. */
  closed: CloseReason[]
  disconnect(): Promise<void>
}

export interface PageClient {
  /** Collect, describe and verify each provider. */
  discover(): Promise<{ providers: DiscoveredProvider[]; rejected: RejectedProvider[] }>
  /** Connect to a verified provider with a fresh epoch. `onClose` also receives the reason in `Connection.closed`. */
  connect(provider: DiscoveredProvider, onClose?: (reason: CloseReason) => void): Promise<Connection>
  /** `connection.wallet[method](args)`. */
  invoke(connection: Connection, method: keyof WalletInterface, args?: unknown): Promise<unknown>
}
