import type { InboxCloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import {
  bindingKey,
  loadBindings,
  loadCursor,
  saveBindings,
  saveCursor,
  type EpochBinding
} from '../../extension/src/lib/bindings'
import { reconcile } from '../../extension/src/lib/reconcile'
import { createFakeAppex, createFakeBrowser, fakeDeps, INSTANCE, makeMirror } from './fakeBrowser'

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const NOW = 1_000_000

const binding = (n: number, over: Partial<EpochBinding> = {}): EpochBinding => ({
  instanceId: INSTANCE,
  epoch: uuid(n),
  tabId: n,
  frameId: 0,
  origin: 'https://app.example',
  continuityKey: 'k',
  accountContext: 'ctx-a',
  walletRevision: '5',
  boundAt: NOW - 1000,
  ...over
})

async function setup(bindings: EpochBinding[], appexInit = {}, clock = { t: NOW }) {
  const browser = createFakeBrowser()
  const appex = createFakeAppex(appexInit)
  await saveBindings(browser.session, Object.fromEntries(bindings.map(b => [bindingKey(b.instanceId, b.epoch), b])))
  return { browser, appex, deps: fakeDeps(appex, browser, { clock }) }
}

const ev = (
  closeSeq: number,
  n: number,
  reason: InboxCloseEvent['reason'] = 'revoked',
  extra: Partial<InboxCloseEvent> = {}
): InboxCloseEvent => ({
  v: 1,
  closeSeq,
  instanceId: INSTANCE,
  epoch: uuid(n),
  reason,
  ...extra
})

const reasons = (r: Awaited<ReturnType<typeof reconcile>>) =>
  r.closed.map(c => [c.binding.epoch, c.reason, c.notifyPage])

describe('reconcile', () => {
  it('step 1: no mirror is absent and closes every held epoch lost', async () => {
    const { deps, browser } = await setup([binding(1), binding(2)], { mirrorState: 'absent' })
    const r = await reconcile(deps)
    expect(r.kind).toBe('absent')
    expect(r.mirror).toBeUndefined()
    expect(reasons(r)).toEqual([
      [uuid(1), 'lost', true],
      [uuid(2), 'lost', true]
    ])
    expect(await loadBindings(browser.session)).toEqual({})
    expect(deps.closedLog).toHaveLength(2)
  })

  it('absent resets the cursor, the next container numbers events from the start', async () => {
    const { deps, browser } = await setup([], { mirrorState: 'absent' })
    await saveCursor(browser.session, 57)
    await reconcile(deps)
    expect(await loadCursor(browser.session)).toBe(0)
  })

  it('corrupt mirror behaves as absent', async () => {
    const { deps, browser } = await setup([binding(1)], { mirrorState: 'corrupt', mirror: makeMirror() })
    const r = await reconcile(deps)
    expect(r.kind).toBe('absent')
    expect(r.mirror).toBeUndefined()
    expect(reasons(r)).toEqual([[uuid(1), 'lost', true]])
    expect(await loadBindings(browser.session)).toEqual({})
    // A mirror that reads but has the wrong shape is no better.
    const bad = await setup([binding(1)], { mirrorState: 'ok', mirror: { v: 1, snapshot: {} } as never })
    expect((await reconcile(bad.deps)).kind).toBe('absent')
  })

  it('step 2: revision change closes every epoch of that revision, context change only when ready', async () => {
    const held = [binding(1), binding(2, { walletRevision: '6' }), binding(3, { accountContext: 'ctx-b' })]
    const building = await setup(held, {
      mirrorState: 'ok',
      mirror: makeMirror({ readiness: 'building', revision: '6' })
    })
    const rb = await reconcile(building.deps)
    expect(rb.kind).toBe('present')
    // revision differs for 1 and 3 (both '5'); context differences do not matter while building.
    expect(reasons(rb)).toEqual([
      [uuid(1), 'account-changed', true],
      [uuid(3), 'account-changed', true]
    ])

    const ready = await setup(held, { mirrorState: 'ok', mirror: makeMirror({ readiness: 'ready', revision: '5' }) })
    const rr = await reconcile(ready.deps)
    // revision 5 matches 1 and 3; 2 differs by revision; 3 also by context (ready).
    expect(reasons(rr).sort()).toEqual(
      [
        [uuid(2), 'account-changed', true],
        [uuid(3), 'account-changed', true]
      ].sort()
    )
    expect(Object.keys(await loadBindings(ready.browser.session))).toEqual([bindingKey(INSTANCE, uuid(1))])
  })

  it('step 2 is skipped for a none mirror, which is its own state', async () => {
    const { deps, browser } = await setup([binding(1)], {
      mirrorState: 'ok',
      mirror: makeMirror({ readiness: 'none', revision: '0' })
    })
    const r = await reconcile(deps)
    expect(r.kind).toBe('none')
    expect(r.closed).toEqual([])
    expect(Object.keys(await loadBindings(browser.session))).toHaveLength(1)
  })

  it("step 3: events apply per (instanceId, epoch) and never close another tab's epoch", async () => {
    const { deps, browser } = await setup([binding(1), binding(2)], {
      mirrorState: 'ok',
      mirror: makeMirror(),
      events: [
        ev(1, 2, 'revoked'),
        ev(2, 99, 'revoked'),
        { ...ev(3, 1, 'lost'), instanceId: '44444444-4444-4444-8444-444444444444' }
      ]
    })
    const r = await reconcile(deps)
    expect(reasons(r)).toEqual([[uuid(2), 'revoked', true]])
    expect(Object.keys(await loadBindings(browser.session))).toEqual([bindingKey(INSTANCE, uuid(1))])
  })

  it('notifyPage false is not echoed', async () => {
    const { deps } = await setup([binding(1)], {
      mirrorState: 'ok',
      mirror: makeMirror(),
      events: [ev(1, 1, 'lost', { notifyPage: false })]
    })
    const r = await reconcile(deps)
    expect(reasons(r)).toEqual([[uuid(1), 'lost', false]])
  })

  it('gap closes all lost', async () => {
    const { deps, browser } = await setup([binding(1), binding(2)], {
      mirrorState: 'ok',
      mirror: makeMirror(),
      gap: true
    })
    const r = await reconcile(deps)
    expect(reasons(r)).toEqual([
      [uuid(1), 'lost', true],
      [uuid(2), 'lost', true]
    ])
    expect(await loadBindings(browser.session)).toEqual({})
  })

  it('an event that is not an event is a gap', async () => {
    const { deps } = await setup([binding(1)], {
      mirrorState: 'ok',
      mirror: makeMirror(),
      events: [{ closeSeq: 5, reason: 'bogus' } as never]
    })
    expect(reasons(await reconcile(deps))).toEqual([[uuid(1), 'lost', true]])
  })

  it("cursor is the highest event read, not the mirror's", async () => {
    const mirror = makeMirror()
    mirror.snapshot.closeSeq = 50
    const { deps, browser, appex } = await setup([binding(1)], {
      mirrorState: 'ok',
      mirror,
      events: [ev(3, 99), ev(9, 98), ev(7, 97)]
    })
    await reconcile(deps)
    expect(await loadCursor(browser.session)).toBe(9)
    // The next sync asks after the saved cursor.
    await reconcile(deps)
    expect((appex.requests[appex.requests.length - 1] as { cursor: number }).cursor).toBe(9)
  })

  it('a lost cursor restarts at 0 and the replayed events close idempotently', async () => {
    const { deps, browser, appex } = await setup([binding(1), binding(2)], {
      mirrorState: 'ok',
      mirror: makeMirror(),
      events: [ev(1, 1), ev(2, 1), ev(3, 5)]
    })
    await saveCursor(browser.session, 3)
    expect(reasons(await reconcile(deps))).toEqual([]) // nothing after 3
    delete browser.data['bsv.cursor'] // extension storage wiped
    const r = await reconcile(deps)
    expect((appex.requests[appex.requests.length - 1] as { cursor: number }).cursor).toBe(0)
    expect(reasons(r)).toEqual([[uuid(1), 'revoked', true]]) // closed once, the duplicate is a no-op
    expect(await loadCursor(browser.session)).toBe(3)
    expect(Object.keys(await loadBindings(browser.session))).toEqual([bindingKey(INSTANCE, uuid(2))])
  })

  it('step 6: epoch older than 24 h closes lost', async () => {
    const clock = { t: NOW + 24 * 3600 * 1000 }
    const { deps } = await setup(
      [binding(1, { boundAt: NOW }), binding(2, { boundAt: NOW + 1000 })],
      { mirrorState: 'ok', mirror: makeMirror() },
      clock
    )
    expect(reasons(await reconcile(deps))).toEqual([[uuid(1), 'lost', true]])
  })

  it('a native failure rejects with a typed error and changes nothing', async () => {
    const { deps, browser } = await setup([binding(1)], { keyMissing: true })
    await expect(reconcile(deps)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
    expect(Object.keys(await loadBindings(browser.session))).toHaveLength(1)
  })
})
