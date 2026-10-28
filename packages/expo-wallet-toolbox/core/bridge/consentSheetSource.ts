/**
 * The seam between the consent store and the PermissionSheet's `connection` kind (spec 6.4).
 *
 * The store is created by whoever composes the bridge (the dispatcher's `consent` dependency);
 * the sheet only needs to read its pending requests, answer them and know which flags apply. The
 * host registers the store here once. Without a registered source the sheet shows no connection
 * requests, which is also what a wallet with no bridge should do.
 *
 * Approval is answered here, not in the UI, so the reconnect token reaches the transport in the
 * same place whichever surface approved: the token is minted once, handed over once, and never
 * kept (6.4).
 */
import type { ConsentAnswerContext, ConsentStore, PendingConsent } from './consent'
import { effectiveUnverified, resolvePermissionPolicy, type PermissionPolicy, type SeekFlags } from './permissionPolicy'
import type { Attestation } from './protocol/origin'

export interface ConsentSheetSource {
  store: Pick<ConsentStore, 'listPending' | 'answerConsent' | 'onChange'>
  /** The current wallet revision and profile: an answer carries them so a stale one is dropped. */
  context(): ConsentAnswerContext
  /** The effective policy (host statement plus the user's stored policy). Defaults to the host's. */
  policy?(): PermissionPolicy
}

let source: ConsentSheetSource | undefined
let detach: (() => void) | undefined
let snapshot: PendingConsent[] = []
const listeners = new Set<() => void>()

function refresh(): void {
  snapshot = source === undefined ? [] : source.store.listPending()
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // A listener must not stop the others.
    }
  }
}

export function setConsentSheetSource(next: ConsentSheetSource | undefined): void {
  detach?.()
  detach = undefined
  source = next
  if (next !== undefined) detach = next.store.onChange(refresh)
  refresh()
}

/** For `useSyncExternalStore`: the snapshot only changes when the pending set does. */
export function subscribeConsentRequests(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getPendingConnections(): PendingConsent[] {
  return snapshot
}

/** The flags the connection sheet describes for a site of this attestation (spec 6.4, 6.5). */
export function connectionFlags(attestation: Attestation): SeekFlags {
  const policy = source?.policy?.() ?? resolvePermissionPolicy()
  return attestation === 'unattested' ? effectiveUnverified(policy) : policy.verified
}

/**
 * Answers a pending connection request. Approve of an unverified site hands the new reconnect
 * token, through its own transport, to each live binding that was parked behind this request; a
 * transport that cannot take it (it never registered `deliverReconnectToken`) does not get one.
 */
export async function answerConnection(requestId: string, approve: boolean): Promise<void> {
  const src = source
  if (src === undefined) return
  const pending = src.store.listPending().find(p => p.requestId === requestId)
  if (pending === undefined) return
  const result = await src.store.answerConsent(requestId, approve, src.context())
  if (result?.reconnectToken === undefined) return
  // Loaded on demand: the runtime pulls in the secure-store native module, which the sheet itself
  // (and its tests) must not need just to render a request.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getBindingRegistry, getTransport } = require('./runtime') as typeof import('./runtime')
  // Only the bindings that were parked behind this request get the token, each through its own
  // transport. A binding of the same origin that never asked (connected already, or another
  // instance that has sent no interactive request) is not handed a credential for the site.
  const waiting = new Set(result.epochs)
  for (const b of getBindingRegistry().live()) {
    if (!waiting.has(b.epoch) || b.applicationOrigin !== pending.origin) continue
    if (b.attestation !== 'unattested') continue
    const transport = getTransport(b.transportId)
    if (transport?.deliverReconnectToken === undefined) continue
    try {
      transport.deliverReconnectToken(b, result.reconnectToken)
    } catch (e) {
      console.warn('[bridge] reconnect token delivery failed', e instanceof Error ? e.message : String(e))
    }
  }
}
