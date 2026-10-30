/**
 * Epoch bindings and the reconcile cursor, kept in `storage.session` (spec 6.9, 6.10). The background
 * is non-persistent, so nothing here lives in module state except a per-area write queue.
 */
import { BINDING_CAPS } from '../../../shared/constants'
import { resourceLimit, type ConnectionError } from './errors'

export interface EpochBinding {
  instanceId: string
  epoch: string
  tabId: number
  frameId: number
  origin: string
  continuityKey: string
  accountContext: string
  walletRevision: string
  boundAt: number
}

export type SessionArea = BrowserStorageArea

const BINDINGS_KEY = 'bsv.bindings'
const CURSOR_KEY = 'bsv.cursor'

export const bindingKey = (instanceId: string, epoch: string): string => `${instanceId}|${epoch}`

const queues = new WeakMap<object, Promise<unknown>>()

/**
 * Serialises read-modify-write sequences on one storage area. One background context runs at a time,
 * so an in-memory chain is enough; it is only a guard against interleaved awaits within that context.
 */
export function withSessionLock<T>(area: SessionArea, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(area) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  queues.set(
    area,
    run.catch(() => undefined)
  )
  return run
}

function isBinding(v: unknown): v is EpochBinding {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b.instanceId === 'string' &&
    typeof b.epoch === 'string' &&
    typeof b.tabId === 'number' &&
    typeof b.frameId === 'number' &&
    typeof b.origin === 'string' &&
    typeof b.continuityKey === 'string' &&
    typeof b.accountContext === 'string' &&
    typeof b.walletRevision === 'string' &&
    typeof b.boundAt === 'number'
  )
}

export async function loadBindings(area: SessionArea): Promise<Record<string, EpochBinding>> {
  const raw = (await area.get(BINDINGS_KEY))[BINDINGS_KEY]
  const out: Record<string, EpochBinding> = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) if (isBinding(v)) out[k] = v
  }
  return out
}

export async function saveBindings(area: SessionArea, bindings: Record<string, EpochBinding>): Promise<void> {
  await area.set({ [BINDINGS_KEY]: bindings })
}

export async function getBinding(
  area: SessionArea,
  instanceId: string,
  epoch: string
): Promise<EpochBinding | undefined> {
  return (await loadBindings(area))[bindingKey(instanceId, epoch)]
}

export async function loadCursor(area: SessionArea): Promise<number> {
  const raw = (await area.get(CURSOR_KEY))[CURSOR_KEY]
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

export async function saveCursor(area: SessionArea, cursor: number): Promise<void> {
  await area.set({ [CURSOR_KEY]: cursor })
}

/** 8 live bindings per origin and 64 overall (spec 6.11). Local, before anything is staged. */
export function checkBindingCaps(bindings: Record<string, EpochBinding>, origin: string): ConnectionError | undefined {
  const all = Object.values(bindings)
  if (all.length >= BINDING_CAPS.total) return resourceLimit('Too many open wallet connections')
  if (all.filter(b => b.origin === origin).length >= BINDING_CAPS.perOrigin) {
    return resourceLimit('Too many open wallet connections for this site')
  }
  return undefined
}
