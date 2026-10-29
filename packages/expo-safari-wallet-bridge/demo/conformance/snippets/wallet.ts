/**
 * LOCAL REPLACEMENT for fast's src/snippets/wallet.ts (see ../SOURCE.md). The vendored snippets call
 * `createWalletClient(originator?)`; here that returns an `@bsv/sdk` WalletClient over the BRC-185 bridge connection
 * the demo page currently holds. The originator is ignored: BRC-185 supplies the real page origin itself.
 */
import { WalletClient } from '@bsv/sdk'
import { createBridgeWallet } from '../../bridgeWallet'
import type { Connection, PageClient } from '../../../src/testing/pageClient'

let current: { client: PageClient; connection: Connection } | undefined

/** Called by the demo after connect (with the connection) and after disconnect (with nothing). */
export function setBridgeConnection(client: PageClient | undefined, connection: Connection | undefined): void {
  current = client && connection ? { client, connection } : undefined
}

export function hasBridgeConnection(): boolean {
  return current !== undefined
}

export function createWalletClient(_originator?: string): WalletClient {
  if (!current) throw new Error('not connected: press connect first')
  return new WalletClient(createBridgeWallet(current.client, current.connection), undefined)
}
