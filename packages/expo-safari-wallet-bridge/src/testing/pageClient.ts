/**
 * A minimal BRC-185 section 4.2 controller (spec 6.16): what project 3's SDK will do, just enough to drive the
 * extension from jest and from the demo page. It installs its announcement listener, dispatches
 * `brc185:request-provider`, collects announcements for 200 ms, calls `describe` with the real origin and a fresh
 * 32-byte challenge under a 1000 ms deadline, verifies the Ed25519 signature and the echoed challenge
 * (section 3), then `connect`s with a fresh UUIDv4 epoch. It is not the SDK and not a chooser.
 *
 * Browser-safe: it uses only the window it is given, `crypto.getRandomValues` and P1's pure protocol modules.
 */
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import { verifyDescribeProof, type Descriptor } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import {
  isConnectionError,
  type ConnectionError,
  type ConnectionErrorCode
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'
import type { CloseReason } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { CHALLENGE_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import type { WalletInterface } from '@bsv/sdk'

export { isConnectionError }
export type { ConnectionError, ConnectionErrorCode, CloseReason }

/** The `brc185:announce-provider` handle. */
export interface PageProviderHandle {
  describe(origin: string, challenge: string): Promise<unknown>
  connect(origin: string, epoch: string, onClose: (reason: CloseReason) => void): Promise<WalletInterface>
  disconnect(epoch: string): Promise<void>
}

export interface PageClientWindow {
  addEventListener(type: string, listener: (e: any) => void): void
  removeEventListener(type: string, listener: (e: any) => void): void
  dispatchEvent(e: unknown): boolean
  CustomEvent: new (type: string, init: { detail: unknown }) => unknown
  location: { origin: string }
  crypto: { getRandomValues<T extends ArrayBufferView>(a: T): T }
}

export interface PageClientOptions {
  /** Announcement collection window (BRC-185 section 4.2). */
  collectMs?: number
  /** Describe deadline (BRC-185 section 4.2). */
  describeDeadlineMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: any) => void
}

export interface DiscoveredProvider {
  requestId: string
  handle: PageProviderHandle
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
  /** Dispatch the request, collect for the window, describe and verify each announcement. */
  discover(): Promise<{ providers: DiscoveredProvider[]; rejected: RejectedProvider[] }>
  /** Connect to a verified provider with a fresh epoch. `onClose` also receives the reason in `Connection.closed`. */
  connect(provider: DiscoveredProvider, onClose?: (reason: CloseReason) => void): Promise<Connection>
  /** `connection.wallet[method](args)`. */
  invoke(connection: Connection, method: keyof WalletInterface, args?: unknown): Promise<unknown>
}

export function createPageClient(win: PageClientWindow, opts: PageClientOptions = {}): PageClient {
  const collectMs = opts.collectMs ?? 200
  const deadlineMs = opts.describeDeadlineMs ?? 1000
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((t: any) => clearTimeout(t))

  const random = (n: number): Uint8Array => win.crypto.getRandomValues(new Uint8Array(n))
  const uuid = (): string => {
    const b = random(16)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setT(() => reject(new Error('describe deadline')), ms)
      p.then(
        v => {
          clearT(t)
          resolve(v)
        },
        e => {
          clearT(t)
          reject(e)
        }
      )
    })
  }

  async function discover() {
    const requestId = uuid()
    const announced: PageProviderHandle[] = []
    const listener = (e: any): void => {
      const d = e?.detail
      if (!d || d.version !== 1 || d.requestId !== requestId || !d.handle) return
      announced.push(d.handle as PageProviderHandle)
    }
    win.addEventListener('brc185:announce-provider', listener) // listener first, then the request
    win.dispatchEvent(new win.CustomEvent('brc185:request-provider', { detail: { version: 1, requestId } }))
    await new Promise<void>(resolve => setT(resolve, collectMs))
    win.removeEventListener('brc185:announce-provider', listener)

    const providers: DiscoveredProvider[] = []
    const rejected: RejectedProvider[] = []
    for (const handle of announced) {
      const challenge = b64uEncode(random(CHALLENGE_BYTES))
      try {
        const response = await withDeadline(handle.describe(win.location.origin, challenge), deadlineMs)
        const descriptor = verifyDescribeProof(response, { origin: win.location.origin, challenge })
        providers.push({ requestId, handle, descriptor })
      } catch (error) {
        rejected.push({ requestId, reason: error instanceof Error ? error.message : 'describe failed', error })
      }
    }
    return { providers, rejected }
  }

  async function connect(provider: DiscoveredProvider, onClose?: (reason: CloseReason) => void): Promise<Connection> {
    const epoch = uuid()
    const closed: CloseReason[] = []
    const wallet = await provider.handle.connect(win.location.origin, epoch, reason => {
      closed.push(reason)
      onClose?.(reason)
    })
    return {
      epoch,
      provider,
      wallet,
      closed,
      disconnect: () => provider.handle.disconnect(epoch)
    }
  }

  function invoke(connection: Connection, method: keyof WalletInterface, args: unknown = {}): Promise<unknown> {
    const fn = connection.wallet[method] as unknown as (a: unknown) => Promise<unknown>
    return fn.call(connection.wallet, args)
  }

  return { discover, connect, invoke }
}
