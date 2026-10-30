/**
 * Pickup (spec 6.11): read the results for the ids a content script is waiting on, convert them, drop the
 * calls from the unresolved table, and acknowledge. A pending call never times out here (BRC-219): it ends on
 * a result, an error or a close.
 *
 * Conversion: `ok` becomes a result item; any error is relayed raw and unchanged (a `domain:'brc185'`
 * ConnectionError or the wallet's `{code, message, data}`); a purged result is `CONNECTION_CLOSED` /
 * `unknown`; an id still waiting when the mirror is absent (logout, Delete Wallet reset the container, so
 * the result can never come) is `CONNECTION_CLOSED` / `unknown`.
 *
 * A native failure rejects the whole pickup and changes nothing: the content script keeps its table and
 * polls again. Results for ids that are no longer outstanding (the page already resolved them, an ack
 * failed) are never delivered twice; they are only acknowledged again.
 */
import type { XdmError } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { parseStrictJson } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/json'
import { withSessionLock } from './bindings'
import { fromBase64 } from './bytes'
import { unknownDelivery } from './errors'
import { loadUnresolved, saveUnresolved } from './limits'
import { reconcile, type ExtDeps } from './reconcile'

export type PickupItem =
  | { id: string; kind: 'result'; result: unknown }
  | { id: string; kind: 'error'; error: XdmError['error'] }

/** Most ids one pickup reads; the unresolved caps keep real tables far below this. */
const MAX_IDS = 256

const unavailable = (): XdmError['error'] => unknownDelivery('CONNECTION_CLOSED', 'The result is no longer available')

type Read = { state: 'none' } | { state: 'purged' } | { state: 'result'; bytes: Uint8Array } | { state: 'unreadable' }

function decode(id: string, bytes: Uint8Array): PickupItem {
  try {
    const v = parseStrictJson(new TextDecoder().decode(bytes)) as Record<string, unknown>
    if (v && v.v === 1 && v.id === id && typeof v.ok === 'boolean') {
      if (v.ok) return { id, kind: 'result', result: v.result }
      if (typeof v.error === 'object' && v.error !== null) {
        return { id, kind: 'error', error: v.error as XdmError['error'] }
      }
    }
  } catch {
    // falls through to the unreadable case
  }
  return {
    id,
    kind: 'error',
    error: unknownDelivery('CONNECTION_CLOSED', 'The wallet sent a result that could not be read')
  }
}

export async function pickup(deps: ExtDeps, ids: string[]): Promise<PickupItem[]> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string'))].slice(0, MAX_IDS)
  if (want.length === 0) return []

  const first = await deps.native.results(want.map(id => ({ id })))
  const reads = new Map<string, Read>()
  for (const item of first.results) {
    if (!want.includes(item.id)) continue
    if (item.state !== 'result') {
      reads.set(item.id, { state: item.state })
      continue
    }
    const chunks: Uint8Array[] = [fromBase64(item.bytes)]
    let read: Read | undefined
    for (let part = 1; part < item.parts; part++) {
      const more = (await deps.native.results([{ id: item.id, part }])).results[0]
      if (!more || more.state === 'none' || more.state === 'purged') {
        read = { state: 'purged' } // the rest vanished between reads: the result is gone
        break
      }
      if (more.state !== 'result' || more.part !== part || more.parts !== item.parts) {
        read = { state: 'unreadable' }
        break
      }
      chunks.push(fromBase64(more.bytes))
    }
    if (!read) {
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        joined.set(c, at)
        at += c.length
      }
      read = { state: 'result', bytes: joined }
    }
    reads.set(item.id, read)
  }

  // Reconcile after reading: an absent mirror closes whatever is still waiting. If the appex cannot be
  // reached now, the results already read still count and nothing is closed.
  let absent = false
  try {
    absent = (await reconcile(deps)).kind === 'absent'
  } catch {
    absent = false
  }

  const converted = new Map<string, PickupItem>()
  const toAck: string[] = []
  for (const id of want) {
    const r = reads.get(id) ?? { state: 'none' as const }
    if (r.state === 'result') {
      converted.set(id, decode(id, r.bytes))
      toAck.push(id)
    } else if (r.state === 'purged') {
      converted.set(id, { id, kind: 'error', error: unavailable() })
      toAck.push(id)
    } else if (r.state === 'unreadable') {
      converted.set(id, decode(id, new Uint8Array()))
      toAck.push(id)
    } else if (absent) {
      converted.set(id, { id, kind: 'error', error: unavailable() })
    }
  }

  // Only calls still outstanding are delivered, so a second result for a resolved id is dropped here.
  const out: PickupItem[] = []
  await withSessionLock(deps.session, async () => {
    const unresolved = await loadUnresolved(deps.session)
    for (const id of want) {
      const item = converted.get(id)
      if (!item || !unresolved[id]) continue
      delete unresolved[id]
      out.push(item)
    }
    await saveUnresolved(deps.session, unresolved)
  })

  if (toAck.length > 0) {
    try {
      await deps.native.ack(toAck)
    } catch {
      // The results are purged by the app within 15 minutes; the calls are already delivered.
    }
  }
  return out
}
