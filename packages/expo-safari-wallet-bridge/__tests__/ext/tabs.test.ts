import { CLOSING_GRACE_MS } from '../../shared/constants'
import { bindingKey, loadBindings } from '../../extension/src/lib/bindings'
import { loadUnresolved } from '../../extension/src/lib/limits'
import { stageInvoke } from '../../extension/src/lib/stage'
import {
  detectGoneTabs,
  flushDisconnects,
  loadClosing,
  markClosing,
  markTabClosing,
  reregister
} from '../../extension/src/lib/tabs'
import { bind, setup, uuid, type Setup } from './stageHelpers'

const stageOne = async (s: Setup, tab: number, n = 1, frameOver = {}) => {
  const b = await bind(s, tab, frameOver)
  const out = await stageInvoke(s.deps, { ...b, invokeId: uuid(600 + n), method: 'getHeight', params: {} })
  if (out.kind !== 'staged') throw new Error('setup')
  return { ...b, recordId: out.recordId }
}
const key = (b: { instanceId: string; epoch: string }) => bindingKey(b.instanceId, b.epoch)
const records = (s: Setup) => [...s.appex.records.values()].map(r => JSON.parse(Buffer.from(r.bytes).toString('utf8')))

describe('tab lifecycle', () => {
  it('tab close, frame unload, bfcache re-register within 5 s writes no disconnect', async () => {
    const s = setup()
    const a = await stageOne(s, 1)
    const b = await stageOne(s, 2, 2)
    await markTabClosing(s.deps, 1) // tabs.onRemoved
    await markTabClosing(s.deps, 2, 0) // frame unload
    s.clock.t += CLOSING_GRACE_MS - 1
    expect(await flushDisconnects(s.deps, s.clock.t)).toEqual([]) // still inside the grace
    await reregister(s.deps, key(a.binding)) // restored from the bfcache
    await reregister(s.deps, key(b.binding))
    s.clock.t += 10 * CLOSING_GRACE_MS
    expect(await flushDisconnects(s.deps, s.clock.t)).toEqual([])
    expect(records(s).filter(r => r.kind === 'disconnect')).toEqual([])
    expect(Object.keys(await loadBindings(s.browser.session))).toHaveLength(2)
    expect(await loadClosing(s.browser.session)).toEqual({})
  })

  it('disconnect written after grace only for epochs that staged', async () => {
    const s = setup()
    const staged = await stageOne(s, 1)
    const idle = await bind(s, 2) // connected, never staged anything
    await markTabClosing(s.deps, 1)
    await markTabClosing(s.deps, 2)
    s.clock.t += CLOSING_GRACE_MS
    const done = await flushDisconnects(s.deps, s.clock.t)
    expect(done.sort()).toEqual([key(staged.binding), key(idle.binding)].sort())

    const disconnects = records(s).filter(r => r.kind === 'disconnect')
    expect(disconnects).toHaveLength(1)
    expect(disconnects[0]).toEqual({
      v: 1,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: 'disconnect',
      epoch: staged.binding.epoch,
      instanceId: staged.binding.instanceId,
      continuityKey: 'k',
      origin: staged.binding.origin,
      accountContext: 'ctx-a',
      walletRevision: '5',
      boundAt: staged.binding.boundAt,
      createdAt: s.clock.t,
      notAfter: s.clock.t + 15 * 60 * 1000
    })
    expect(disconnects[0]).not.toHaveProperty('method')
    expect(disconnects[0]).not.toHaveProperty('args')
    expect(await loadBindings(s.browser.session)).toEqual({})
    expect(await loadClosing(s.browser.session)).toEqual({})
    // Nothing waits on the closed epoch any more.
    expect(await loadUnresolved(s.browser.session)).toEqual({})
  })

  it('no handoff for disconnects', async () => {
    const s = setup()
    await stageOne(s, 1)
    await markTabClosing(s.deps, 1)
    s.clock.t += CLOSING_GRACE_MS
    await flushDisconnects(s.deps, s.clock.t)
    expect(s.browser.tabs.updates).toEqual([])
    expect(s.appex.requests.some(r => r.op === 'nudge')).toBe(false)
  })

  it('a frame unload closes only that frame, a tab close every frame of the tab', async () => {
    const s = setup()
    const top = await stageOne(s, 1, 1)
    const sub = await bind(s, 1, { epoch: uuid(77), frameId: 5 })
    const hit = await markTabClosing(s.deps, 1, 5)
    expect(hit).toEqual([key(sub.binding)])
    const all = await markTabClosing(s.deps, 1)
    expect(all.sort()).toEqual([key(top.binding), key(sub.binding)].sort())
    // markClosing keeps the first timestamp.
    const t0 = (await loadClosing(s.browser.session))[key(sub.binding)]
    s.clock.t += 1000
    await markClosing(s.deps, key(sub.binding))
    expect((await loadClosing(s.browser.session))[key(sub.binding)]).toBe(t0)
  })

  it('a tab closed while the background was unloaded is detected by tabs.query at next wake', async () => {
    const s = setup()
    const a = await stageOne(s, 1)
    const b = await stageOne(s, 2, 2)
    s.browser.tabs.open.delete(1) // closed while no background was running: no onRemoved was seen
    const hit = await detectGoneTabs(s.deps, s.browser.tabs)
    expect(hit).toEqual([key(a.binding)])
    s.clock.t += CLOSING_GRACE_MS
    expect(await flushDisconnects(s.deps, s.clock.t)).toEqual([key(a.binding)])
    expect(Object.keys(await loadBindings(s.browser.session))).toEqual([key(b.binding)])
    expect(
      records(s)
        .filter(r => r.kind === 'disconnect')
        .map(r => r.epoch)
    ).toEqual([a.binding.epoch])
  })

  it('a failed disconnect write keeps the epoch to retry at the next wake', async () => {
    const s = setup()
    const a = await stageOne(s, 1)
    await markTabClosing(s.deps, 1)
    s.clock.t += CLOSING_GRACE_MS
    s.appex.dropRequest.add('stage')
    expect(await flushDisconnects(s.deps, s.clock.t)).toEqual([])
    expect(Object.keys(await loadBindings(s.browser.session))).toEqual([key(a.binding)])
    s.appex.dropRequest.clear()
    expect(await flushDisconnects(s.deps, s.clock.t + 1)).toEqual([key(a.binding)])
    expect(records(s).filter(r => r.kind === 'disconnect')).toHaveLength(1)
  })

  it('a call from a closing frame clears the closing mark', async () => {
    const s = setup()
    const a = await stageOne(s, 1)
    await markTabClosing(s.deps, 1)
    await stageInvoke(s.deps, {
      frame: a.frame,
      binding: a.binding,
      invokeId: uuid(650),
      method: 'getHeight',
      params: {}
    })
    expect(await loadClosing(s.browser.session)).toEqual({})
  })
})
