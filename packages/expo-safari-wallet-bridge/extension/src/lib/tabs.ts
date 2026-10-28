/**
 * Tab and frame lifecycle (spec 6.11, "Tab close and frame unload"). A closing tab, a frame unload or a
 * top-frame navigation puts the epoch into `closing` with a timestamp. After `CLOSING_GRACE_MS` without a
 * re-register (a page restored from the back/forward cache re-registers) the epoch becomes a
 * `kind:'disconnect'` record, but only if something was staged for it: otherwise the app has no binding and
 * the extension just forgets the epoch. A disconnect never triggers a handoff; the app writes the close
 * event the next time it drains.
 *
 * Also holds the ids of records whose withdrawal could not be confirmed (they stay in `closing` and are
 * withdrawn at the next wake, see `retryWithdrawals` in stage.ts).
 */
import { INBOX_MAX_VALIDITY_MS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import type { InboxRecord } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { CLOSING_GRACE_MS } from '../../../shared/constants'
import { bindingKey, loadBindings, saveBindings, withSessionLock, type SessionArea } from './bindings'
import { toBase64, utf8Bytes } from './bytes'
import { uuidv4 } from './ids'
import { loadUnresolved, saveUnresolved } from './limits'
import type { ExtDeps } from './reconcile'

const CLOSING_KEY = 'bsv.closing'
const STAGED_KEY = 'bsv.stagedEpochs'
const WITHDRAWALS_KEY = 'bsv.withdrawals'

async function loadRecord<T>(area: SessionArea, key: string, ok: (v: unknown) => v is T): Promise<Record<string, T>> {
  const raw = (await area.get(key))[key]
  const out: Record<string, T> = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) if (ok(v)) out[k] = v
  }
  return out
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isTrue = (v: unknown): v is true => v === true

export const loadClosing = (area: SessionArea): Promise<Record<string, number>> =>
  loadRecord(area, CLOSING_KEY, isNumber)

/** Epoch keys that staged at least one invoke. */
export const loadStagedEpochs = (area: SessionArea): Promise<Record<string, true>> =>
  loadRecord(area, STAGED_KEY, isTrue)

export async function markStaged(area: SessionArea, instanceId: string, epoch: string): Promise<void> {
  await withSessionLock(area, async () => {
    const staged = await loadStagedEpochs(area)
    staged[bindingKey(instanceId, epoch)] = true
    await area.set({ [STAGED_KEY]: staged })
  })
}

/** Record ids whose `withdraw` could not be confirmed; withdrawn again at the next wake. */
export async function loadWithdrawals(area: SessionArea): Promise<string[]> {
  const raw = (await area.get(WITHDRAWALS_KEY))[WITHDRAWALS_KEY]
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

export async function saveWithdrawals(area: SessionArea, ids: string[]): Promise<void> {
  await area.set({ [WITHDRAWALS_KEY]: ids })
}

/** Starts (or keeps) the grace clock for one epoch. */
export async function markClosing(deps: Pick<ExtDeps, 'session' | 'now'>, epochKey: string): Promise<void> {
  await withSessionLock(deps.session, async () => {
    const closing = await loadClosing(deps.session)
    if (closing[epochKey] === undefined) closing[epochKey] = deps.now()
    await deps.session.set({ [CLOSING_KEY]: closing })
  })
}

/** A content script (or a page restored from the bfcache) is alive again: the epoch is not closing. */
export async function reregister(deps: Pick<ExtDeps, 'session'>, epochKey: string): Promise<void> {
  await withSessionLock(deps.session, async () => {
    const closing = await loadClosing(deps.session)
    if (closing[epochKey] === undefined) return
    delete closing[epochKey]
    await deps.session.set({ [CLOSING_KEY]: closing })
  })
}

/**
 * Every epoch bound in this tab starts closing. `frameId` narrows it to one frame (frame unload); without
 * it the whole tab goes (`tabs.onRemoved`, top-frame `tabs.onUpdated`).
 */
export async function markTabClosing(
  deps: Pick<ExtDeps, 'session' | 'now'>,
  tabId: number,
  frameId?: number
): Promise<string[]> {
  return withSessionLock(deps.session, async () => {
    const bindings = await loadBindings(deps.session)
    const closing = await loadClosing(deps.session)
    const hit: string[] = []
    for (const [key, b] of Object.entries(bindings)) {
      if (b.tabId !== tabId || (frameId !== undefined && b.frameId !== frameId)) continue
      hit.push(key)
      if (closing[key] === undefined) closing[key] = deps.now()
    }
    if (hit.length > 0) await deps.session.set({ [CLOSING_KEY]: closing })
    return hit
  })
}

/**
 * On every cold wake: a tab that closed while the background was unloaded left no event, so compare the
 * bound tab ids with `tabs.query` and start closing for the ones that are gone.
 */
export async function detectGoneTabs(
  deps: Pick<ExtDeps, 'session' | 'now'>,
  tabs: { query(info: Record<string, unknown>): Promise<Array<{ id?: number }>> }
): Promise<string[]> {
  const open = new Set((await tabs.query({})).map(t => t.id))
  const bindings = await loadBindings(deps.session)
  const gone = new Set<number>()
  for (const b of Object.values(bindings)) if (!open.has(b.tabId)) gone.add(b.tabId)
  const hit: string[] = []
  for (const tabId of gone) hit.push(...(await markTabClosing(deps, tabId)))
  return hit
}

/**
 * Epochs that have been closing for at least `CLOSING_GRACE_MS` are dropped. If they staged something, a
 * disconnect record is written first (full tuple, no method or args, no handoff). A failed write leaves the
 * epoch closing and bound, to be retried at the next wake. Returns the epoch keys that were closed.
 */
export async function flushDisconnects(deps: ExtDeps, now: number): Promise<string[]> {
  const { session, native } = deps
  const closing = await loadClosing(session)
  const due = Object.entries(closing)
    .filter(([, since]) => now - since >= CLOSING_GRACE_MS)
    .map(([key]) => key)
  const done: string[] = []
  for (const key of due) {
    const binding = (await loadBindings(session))[key]
    const staged = (await loadStagedEpochs(session))[key] === true
    if (binding && staged) {
      const record: InboxRecord = {
        v: 1,
        id: uuidv4(),
        kind: 'disconnect',
        epoch: binding.epoch,
        instanceId: binding.instanceId,
        continuityKey: binding.continuityKey,
        origin: binding.origin,
        accountContext: binding.accountContext,
        walletRevision: binding.walletRevision,
        boundAt: binding.boundAt,
        createdAt: now,
        notAfter: now + INBOX_MAX_VALIDITY_MS
      }
      try {
        await native.stage(record.id, toBase64(utf8Bytes(JSON.stringify(record))))
      } catch {
        continue
      }
    }
    await withSessionLock(session, async () => {
      const bindings = await loadBindings(session)
      delete bindings[key]
      await saveBindings(session, bindings)
      const cl = await loadClosing(session)
      delete cl[key]
      const st = await loadStagedEpochs(session)
      delete st[key]
      // Calls still waiting on this epoch have no poller any more; they stop counting against the limits.
      // Their records stay in the queue and resolve through the app's tombstone.
      const unresolved = await loadUnresolved(session)
      for (const [id, e] of Object.entries(unresolved))
        if (bindingKey(e.instanceId, e.epoch) === key) delete unresolved[id]
      await saveUnresolved(session, unresolved)
      await session.set({ [CLOSING_KEY]: cl, [STAGED_KEY]: st })
    })
    done.push(key)
  }
  return done
}
