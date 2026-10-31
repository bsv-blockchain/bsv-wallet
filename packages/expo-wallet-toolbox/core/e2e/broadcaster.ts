/**
 * Posts a pay-review to the E2E mock broadcaster.
 *
 * This is the send path an E2E build uses instead of `sendAddress`. The mock
 * never forwards the body to a network, and this function refuses to run
 * unless the harness is on, so a production bundle cannot reach it: the host
 * only sets the mode from `EXPO_PUBLIC_E2E`.
 */
import { getE2eBroadcasterUrl, isE2eBuild } from './mode'

export async function postE2eBroadcast(to: string, satoshis: number): Promise<string> {
  if (!isE2eBuild()) throw new Error('E2E broadcaster is only available in an E2E build')
  const url = getE2eBroadcasterUrl()
  if (!url) throw new Error('E2E broadcaster is not configured')
  const res = await fetch(`${url}/e2e/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ chain: 'test', to, satoshis })
  })
  const body = (await res.json().catch(() => null)) as { txid?: string; error?: string } | null
  if (!res.ok || !body?.txid) {
    throw new Error(body?.error || 'Test broadcaster refused the payment')
  }
  return body.txid
}
