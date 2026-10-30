/**
 * Adapter: a BRC-100 `WalletInterface` whose every method goes through the stand-in BRC-185 page client
 * (`client.invoke(connection, method, args)`), so the fast.brc.dev conformance snippets can drive the wallet reached
 * through the bridge. Test tool only: not in the package's published files.
 *
 * Errors keep their identity. The connection wallet already rebuilds wallet errors into `Error`s carrying the wire
 * `code`, `name` and `message` (errorCodec `decodeWireError`), and the SDK's `WalletClient` passes substrate errors
 * through untouched, so this adapter only has to make sure a thrown value is an `Error` with those three fields:
 * a plain `{ code, message, name? }` object (what a stub or an older provider throws) is rebuilt as an `Error` that
 * keeps them and any other own fields. A `ConnectionError` is left as it is: it is a transport failure, never a
 * wallet rejection, and the conformance checks must not mistake it for one.
 */
import type { WalletInterface } from '@bsv/sdk'
import { isConnectionError, type Connection, type PageClient } from '../src/testing/pageClient'

/** Typed against `WalletInterface`, so a method added to the SDK fails type-checking here until it is listed. */
const METHODS: Record<keyof WalletInterface, true> = {
  getPublicKey: true,
  revealCounterpartyKeyLinkage: true,
  revealSpecificKeyLinkage: true,
  encrypt: true,
  decrypt: true,
  createHmac: true,
  verifyHmac: true,
  createSignature: true,
  verifySignature: true,
  createAction: true,
  signAction: true,
  abortAction: true,
  listActions: true,
  internalizeAction: true,
  listOutputs: true,
  relinquishOutput: true,
  acquireCertificate: true,
  listCertificates: true,
  proveCertificate: true,
  relinquishCertificate: true,
  discoverByIdentityKey: true,
  discoverByAttributes: true,
  isAuthenticated: true,
  waitForAuthentication: true,
  getHeight: true,
  getHeaderForHeight: true,
  getNetwork: true,
  getVersion: true
}

export const BRIDGE_WALLET_METHODS = Object.keys(METHODS) as (keyof WalletInterface)[]

/** Make a thrown value an `Error` that keeps the wallet error's `code`, `name` and `message`. */
export function toWalletError(e: unknown): unknown {
  if (e instanceof Error || isConnectionError(e)) return e
  if (typeof e === 'object' && e !== null) {
    const o = e as Record<string, unknown>
    const error = new Error(typeof o.message === 'string' ? o.message : 'Wallet call failed')
    Object.assign(error, o) // code, isError, parameter, ... as the wire carried them
    if (typeof o.name === 'string' && o.name) error.name = o.name
    return error
  }
  return Object.assign(new Error(typeof e === 'string' ? e : 'Wallet call failed'), { code: 1 })
}

export function createBridgeWallet(client: PageClient, connection: Connection | undefined): WalletInterface {
  const wallet: Record<string, unknown> = {}
  for (const method of BRIDGE_WALLET_METHODS) {
    wallet[method] = async (args?: unknown) => {
      if (!connection) throw new Error('not connected: press connect first')
      try {
        return await client.invoke(connection, method, args ?? {})
      } catch (e) {
        throw toWalletError(e)
      }
    }
  }
  return wallet as unknown as WalletInterface
}
