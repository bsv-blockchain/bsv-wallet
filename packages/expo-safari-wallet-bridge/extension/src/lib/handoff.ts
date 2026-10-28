/**
 * The doorbell (spec 6.11): navigate the tab to `<scheme>://bridge?v=1&n=<nonce>`. The URL carries no id,
 * origin or payload. Calls queued inside `HANDOFF_COALESCE_MS` of the last handoff for the same tab share it
 * (the wake drains them all); the next call after the window re-triggers, which is also the only retrigger
 * after the user cancels Safari's prompt. From a subframe the background still navigates the top tab (S5).
 */
import { HANDOFF_COALESCE_MS } from '../../../shared/constants'
import { withSessionLock, type SessionArea } from './bindings'
import { randomHex } from './ids'

export interface HandoffDeps {
  session: SessionArea
  now(): number
  tabs: { update(tabId: number, props: { url?: string }): Promise<unknown> }
  /** Overrides the `BRIDGE_SCHEME` build constant (tests). */
  scheme?: string
}

const HANDOFF_KEY = 'bsv.handoff'

async function loadLast(area: SessionArea): Promise<Record<string, number>> {
  const raw = (await area.get(HANDOFF_KEY))[HANDOFF_KEY]
  const out: Record<string, number> = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v
  }
  return out
}

export const handoffUrl = (scheme: string): string => `${scheme}://bridge?v=1&n=${randomHex(8)}`

/**
 * Resolves when the navigation was requested or skipped. A failing `tabs.update` is swallowed after the
 * window is released: the record is already staged, so the failure costs one retrigger, not the call.
 */
export async function triggerHandoff(deps: HandoffDeps, tabId: number): Promise<void> {
  const scheme = deps.scheme ?? (typeof BRIDGE_SCHEME === 'string' ? BRIDGE_SCHEME : '')
  if (scheme === '') return
  const key = String(tabId)
  const now = deps.now()
  const go = await withSessionLock(deps.session, async () => {
    const last = await loadLast(deps.session)
    const at = last[key]
    if (at !== undefined && now - at < HANDOFF_COALESCE_MS) return false
    last[key] = now
    await deps.session.set({ [HANDOFF_KEY]: last })
    return true
  })
  if (!go) return
  try {
    await deps.tabs.update(tabId, { url: handoffUrl(scheme) })
  } catch {
    await withSessionLock(deps.session, async () => {
      const last = await loadLast(deps.session)
      delete last[key]
      await deps.session.set({ [HANDOFF_KEY]: last })
    })
  }
}
