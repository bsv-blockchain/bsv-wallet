/**
 * Brings two @bsv/wallet-toolbox-mobile 2.14.3 results in line with what
 * @bsv/sdk 2.8.8+ accepts. Without this, every dApp using the SDK sees them as
 * invalid wallet responses:
 *
 * - createAction: when the permissions manager signs a non-admin action
 *   itself, `noSendChange` still names the unsigned txid next to the signed
 *   `txid` ("noSendChange[0]: expected an outpoint of the returned
 *   transaction"). Signing never moves outputs, so only the txid changes.
 * - discoverByIdentityKey / discoverByAttributes: every trusted match comes
 *   back regardless of `limit`/`offset` ("expected at most the requested
 *   limit"). `totalCertificates` keeps counting every match.
 * - abortAction: that signed no-send action can only be released by its txid,
 *   which the manager refuses from any non-admin originator. The origin that
 *   created it in this session may abort it; the wrapper forwards that one
 *   abort as the admin. Any other reference goes through the manager's own
 *   check unchanged, and a broadcast action is never recorded.
 *
 * bsv-blockchain/ts-stack fixes all three in @bsv/wallet-toolbox 2.14.4; drop this
 * wrapper once @bsv/wallet-toolbox-mobile ships that.
 */

const DEFAULT_DISCOVERY_LIMIT = 10

interface CreateActionResultLike {
  txid?: string
  noSendChange?: string[]
}

interface DiscoveryResultLike {
  totalCertificates: number
  certificates: unknown[]
}

function noSendChangeOnTxid<R>(result: R): R {
  const r = result as CreateActionResultLike | undefined
  if (!r?.txid || !Array.isArray(r.noSendChange)) return result
  const txid = r.txid
  return {
    ...r,
    noSendChange: r.noSendChange.map(outpoint => `${txid}.${outpoint.slice(outpoint.lastIndexOf('.') + 1)}`)
  } as R
}

function discoveryPage<R>(result: R, args: { limit?: number; offset?: number } | undefined): R {
  const r = result as DiscoveryResultLike | undefined
  if (!r || !Array.isArray(r.certificates)) return result
  // A toolbox that pages itself (2.14.4+) returns fewer certificates than it
  // counts whenever paging changed anything; slicing that page again would
  // drop results at any offset past 0.
  if (r.certificates.length !== r.totalCertificates) return result
  const offset = args?.offset ?? 0
  const limit = args?.limit ?? DEFAULT_DISCOVERY_LIMIT
  return { ...r, certificates: r.certificates.slice(offset, offset + limit) } as R
}

function noSendKey(reference: unknown): string {
  return typeof reference === 'string' ? reference.toLowerCase() : ''
}

export function conformWalletResults<T extends object>(adminOriginator: string, manager: T): T {
  // txid of each signed no-send action → the originator that created it.
  const noSendOriginators = new Map<string, string>()
  return new Proxy(manager, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      if (prop === 'createAction') {
        return async (args: { options?: { noSend?: boolean } } | undefined, originator?: string) => {
          const result = noSendChangeOnTxid(await value.call(target, args, originator)) as CreateActionResultLike
          if (args?.options?.noSend === true && result?.txid && originator !== adminOriginator) {
            noSendOriginators.set(noSendKey(result.txid), originator ?? '')
          }
          return result
        }
      }
      if (prop === 'abortAction') {
        return async (args: { reference?: string } | undefined, originator?: string) => {
          const key = noSendKey(args?.reference)
          const owner = noSendOriginators.get(key)
          if (owner === undefined || originator === adminOriginator) return await value.call(target, args, originator)
          if (owner !== (originator ?? '')) throw new Error('The action reference belongs to a different originator.')
          const result = await value.call(target, args, adminOriginator)
          if ((result as { aborted?: boolean } | undefined)?.aborted === true) noSendOriginators.delete(key)
          return result
        }
      }
      if (prop === 'discoverByIdentityKey' || prop === 'discoverByAttributes') {
        return async (...args: unknown[]) =>
          discoveryPage(await value.apply(target, args), args[0] as { limit?: number; offset?: number })
      }
      return value.bind(target)
    }
  }) as T
}
