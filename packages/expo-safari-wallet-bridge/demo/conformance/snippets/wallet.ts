/**
 * LOCAL REPLACEMENT for fast's src/snippets/wallet.ts (see ../SOURCE.md). The vendored snippets call
 * `createWalletClient(originator?)`; here that returns an `@bsv/sdk` WalletClient over the BRC-185 bridge connection
 * the demo page currently holds. The originator is ignored: BRC-185 supplies the real page origin itself.
 */
import { WalletClient, type WalletInterface } from '@bsv/sdk'
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

/**
 * References (or txids when no reference came back) of noSend actions created through the clients below and not yet
 * aborted. The vendored cards abort only on their success path, so the controller calls `releaseOutstandingNoSend`
 * when a card ends to free the locked inputs after a failure or timeout. Best effort: a txid is not necessarily
 * accepted as an abort reference by the wallet.
 */
const outstanding = new Set<string>()

function tracked(wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'createAction') {
        return async (args: Parameters<WalletInterface['createAction']>[0], ...rest: unknown[]) => {
          const created = await (value as (...a: unknown[]) => Promise<any>).call(target, args, ...rest)
          if (args?.options?.noSend) {
            const ref = created?.signableTransaction?.reference ?? created?.txid
            if (typeof ref === 'string') outstanding.add(ref)
          }
          return created
        }
      }
      if (prop === 'abortAction') {
        return async (args: Parameters<WalletInterface['abortAction']>[0], ...rest: unknown[]) => {
          const res = await (value as (...a: unknown[]) => Promise<any>).call(target, args, ...rest)
          if (res?.aborted === true && args?.reference) outstanding.delete(args.reference)
          return res
        }
      }
      return value
    }
  })
}

/** Abort every tracked noSend action still outstanding. Never throws. Returns how many aborts were accepted. */
export async function releaseOutstandingNoSend(): Promise<number> {
  const snapshot = current
  const refs = [...outstanding]
  outstanding.clear()
  if (!snapshot) return 0
  const wallet = createBridgeWallet(snapshot.client, snapshot.connection)
  let released = 0
  for (const reference of refs) {
    try {
      const res = await wallet.abortAction({ reference })
      if (res.aborted === true) released++
    } catch {
      // already processed, unknown to the wallet, or the connection is gone
    }
  }
  return released
}

export function createWalletClient(_originator?: string): WalletClient {
  if (!current) throw new Error('not connected: press connect first')
  return new WalletClient(tracked(createBridgeWallet(current.client, current.connection)), undefined)
}
