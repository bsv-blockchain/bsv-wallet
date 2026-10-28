/**
 * In-flight limits (spec 6.11). The extension tracks every call that has been sent and has no result
 * yet, across all tabs, in `storage.session`, and refuses a new one locally before the app's dispatcher
 * would (`RESOURCE_LIMIT`, `not-sent`). It therefore never produces that error by batching.
 */
import { UNRESOLVED_CAPS } from '../../../shared/constants'
import type { EpochBinding, SessionArea } from './bindings'
import { resourceLimit, type ConnectionError } from './errors'

/** A call that was staged (or is being staged) and has no result yet. */
export interface UnresolvedEntry {
  recordId: string
  instanceId: string
  epoch: string
  invokeId: string
  tabId: number
  /** Request bytes, counted against the 5 MiB total. */
  size: number
  /** `staging` until the appex acknowledged the record; then `staged`. */
  state: 'staging' | 'staged'
  /** Kept so a re-stage after a background reload writes the identical record (same digest). */
  createdAt: number
}

export type UnresolvedState = Record<string, UnresolvedEntry>

const UNRESOLVED_KEY = 'bsv.unresolved'

function isEntry(v: unknown): v is UnresolvedEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.recordId === 'string' &&
    typeof e.instanceId === 'string' &&
    typeof e.epoch === 'string' &&
    typeof e.invokeId === 'string' &&
    typeof e.tabId === 'number' &&
    typeof e.size === 'number' &&
    (e.state === 'staging' || e.state === 'staged') &&
    typeof e.createdAt === 'number'
  )
}

export async function loadUnresolved(area: SessionArea): Promise<UnresolvedState> {
  const raw = (await area.get(UNRESOLVED_KEY))[UNRESOLVED_KEY]
  const out: UnresolvedState = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) if (isEntry(v)) out[k] = v
  }
  return out
}

export async function saveUnresolved(area: SessionArea, state: UnresolvedState): Promise<void> {
  await area.set({ [UNRESOLVED_KEY]: state })
}

/** 4 per epoch, 16 overall, 5 MiB overall, counting the new call. `undefined` means it fits. */
export function checkLimits(
  state: UnresolvedState,
  binding: Pick<EpochBinding, 'instanceId' | 'epoch'>,
  sizeBytes: number
): ConnectionError | undefined {
  const all = Object.values(state)
  const inEpoch = all.filter(e => e.instanceId === binding.instanceId && e.epoch === binding.epoch).length
  if (inEpoch >= UNRESOLVED_CAPS.perEpoch) return resourceLimit('Too many calls are waiting on this connection')
  if (all.length >= UNRESOLVED_CAPS.total) return resourceLimit('Too many calls are waiting on the wallet')
  const bytes = all.reduce((sum, e) => sum + e.size, 0)
  if (bytes + sizeBytes > UNRESOLVED_CAPS.bytes) return resourceLimit('Too much data is waiting on the wallet')
  return undefined
}
