/**
 * Reconcile (spec 6.10): one `sync(cursor)` call, then the six steps, before any local answer, describe,
 * connect or stage. Closed epochs are removed from `storage.session` and handed back (and to
 * `deps.onClosed`) so the caller can tell the page.
 */
import type { CloseReason, InboxCloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { isCloseReason } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { EPOCH_HORIZON_MS } from '../../../shared/constants'
import type { Mirror } from '../../../shared/mirror'
import {
  bindingKey,
  loadBindings,
  loadCursor,
  saveBindings,
  saveCursor,
  withSessionLock,
  type EpochBinding,
  type SessionArea
} from './bindings'
import type { NativeClient } from './nativeClient'

export interface ClosedEpoch {
  binding: EpochBinding
  reason: CloseReason
  /** False for a page-initiated disconnect: the page asked for it and is not told (spec 6.10 step 3). */
  notifyPage: boolean
}

export interface ExtDeps {
  native: NativeClient
  session: SessionArea
  now(): number
  /** True only in the plugin's development profile (build constant `allowLocalhostHttp`). */
  allowLocalhostHttp?: boolean
  /** Overrides for the build constants `BRIDGE_NAME` / `BRIDGE_VENDOR` (tests). */
  name?: string
  vendor?: string
  /** Told about every epoch reconcile closes, however it was called. */
  onClosed?(closed: ClosedEpoch[]): void
}

export type ReconcileKind = 'absent' | 'none' | 'present'

export interface ReconcileState {
  kind: ReconcileKind
  /** Set when `kind` is `present`; a `none` mirror carries no usable state. */
  mirror?: Mirror
  closed: ClosedEpoch[]
}

function isMirror(v: unknown): v is Mirror {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Mirror
  const s = m.snapshot as Mirror['snapshot'] | undefined
  return (
    m.v === 1 &&
    typeof s === 'object' &&
    s !== null &&
    typeof s.readiness === 'string' &&
    typeof s.walletRevision === 'string' &&
    typeof s.accountContext === 'string' &&
    typeof s.baseVersion === 'string' &&
    Array.isArray(m.connected) &&
    (m.identityKey === null || typeof m.identityKey === 'string') &&
    typeof m.identityKeyPrompts === 'boolean'
  )
}

function isEvent(v: unknown): v is InboxCloseEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as InboxCloseEvent
  return (
    typeof e.closeSeq === 'number' &&
    Number.isInteger(e.closeSeq) &&
    typeof e.instanceId === 'string' &&
    typeof e.epoch === 'string' &&
    isCloseReason(e.reason)
  )
}

export async function reconcile(deps: ExtDeps): Promise<ReconcileState> {
  const { native, session } = deps
  const cursor = await loadCursor(session)
  const reply = await native.sync(cursor)

  // A torn, truncated or foreign-key mirror reads as absent (the appex says `corrupt`; a shape check
  // here is the second line).
  const mirror = reply.mirrorState === 'ok' && isMirror(reply.mirror) ? reply.mirror : undefined
  const events = Array.isArray(reply.events) ? reply.events : []
  const valid = events.filter(isEvent)
  // An event that is not an event is a lost event: a gap, never a silent skip.
  const gap = reply.gap === true || valid.length !== events.length

  const closed: ClosedEpoch[] = []
  await withSessionLock(session, async () => {
    const held = await loadBindings(session)
    const close = (key: string, reason: CloseReason, notifyPage = true): void => {
      const binding = held[key]
      if (!binding) return // already closed: closes are idempotent
      delete held[key]
      closed.push({ binding, reason, notifyPage })
    }

    if (!mirror) {
      // Step 1. A logout or Delete Wallet resets the container, events included, so every epoch is lost
      // and the next container's event numbers start again from the beginning.
      for (const key of Object.keys(held)) close(key, 'lost')
      await saveCursor(session, 0)
    } else {
      const snap = mirror.snapshot
      // Step 2.
      if (snap.readiness !== 'none') {
        for (const [key, b] of Object.entries(held)) {
          if (b.walletRevision !== snap.walletRevision) close(key, 'account-changed')
          else if (snap.readiness === 'ready' && b.accountContext !== snap.accountContext) {
            close(key, 'account-changed')
          }
        }
      }
      // Step 3. Events apply per (instanceId, epoch); one tab's close never touches another's.
      for (const e of valid) close(bindingKey(e.instanceId, e.epoch), e.reason, e.notifyPage !== false)
      // Step 4.
      if (gap) for (const key of Object.keys(held)) close(key, 'lost')
      // Step 5. The highest event actually read, not the mirror's closeSeq.
      let next = cursor
      for (const e of valid) if (e.closeSeq > next) next = e.closeSeq
      if (gap) {
        // Everything held was just closed, so the gap is handled: move past it, or the same gap
        // (an evicted or unreadable event) would close every later epoch 'lost' again.
        if (typeof reply.gapThrough === 'number' && reply.gapThrough > next) next = reply.gapThrough
        for (const e of events) {
          const seq = (e as { closeSeq?: unknown } | null)?.closeSeq
          if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > next) next = seq
        }
      }
      if (next !== cursor) await saveCursor(session, next)
      // Step 6.
      const now = deps.now()
      for (const [key, b] of Object.entries(held)) if (now - b.boundAt >= EPOCH_HORIZON_MS) close(key, 'lost')
    }
    await saveBindings(session, held)
  })

  if (closed.length > 0) deps.onClosed?.(closed)
  const kind: ReconcileKind = !mirror ? 'absent' : mirror.snapshot.readiness === 'none' ? 'none' : 'present'
  return kind === 'present' ? { kind, mirror, closed } : { kind, closed }
}
