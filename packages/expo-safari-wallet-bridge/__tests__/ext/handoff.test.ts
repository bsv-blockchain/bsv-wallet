import { HANDOFF_COALESCE_MS } from '../../shared/constants'
import { triggerHandoff, type HandoffDeps } from '../../extension/src/lib/handoff'
import { stageInvoke } from '../../extension/src/lib/stage'
import { createFakeBrowser } from './fakeBrowser'
import { bind, setup, uuid } from './stageHelpers'

const SCHEME = 'org.bsvblockchain.wallet'

function handoffSetup() {
  const browser = createFakeBrowser()
  const clock = { t: 5_000_000 }
  const deps: HandoffDeps = { session: browser.session, now: () => clock.t, tabs: browser.tabs, scheme: SCHEME }
  return { browser, clock, deps }
}

describe('triggerHandoff', () => {
  it('coalescing: three records in 3 s share one handoff, the fourth after the window re-triggers', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const hand: HandoffDeps = { session: s.browser.session, now: () => s.clock.t, tabs: s.browser.tabs, scheme: SCHEME }
    for (let i = 0; i < 3; i++) {
      const out = await stageInvoke(s.deps, {
        frame,
        binding,
        invokeId: uuid(100 + i),
        method: 'getHeight',
        params: {}
      })
      expect(out.kind).toBe('staged')
      await triggerHandoff(hand, 1)
      s.clock.t += 1000 // 0, 1000 and 2000 ms after the first
    }
    expect(s.browser.tabs.updates).toHaveLength(1)
    s.clock.t += 1 // 3001 ms after the first
    await triggerHandoff(hand, 1)
    expect(s.browser.tabs.updates).toHaveLength(2)
    expect(s.browser.tabs.updates[1].tabId).toBe(1)
  })

  it('the window is per tab and exactly HANDOFF_COALESCE_MS', async () => {
    const { browser, clock, deps } = handoffSetup()
    await triggerHandoff(deps, 1)
    await triggerHandoff(deps, 2)
    expect(browser.tabs.updates.map(u => u.tabId)).toEqual([1, 2])
    clock.t += HANDOFF_COALESCE_MS - 1
    await triggerHandoff(deps, 1)
    expect(browser.tabs.updates).toHaveLength(2)
    clock.t += 1
    await triggerHandoff(deps, 1)
    expect(browser.tabs.updates).toHaveLength(3)
  })

  it('handoff url carries no id, origin or payload', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const hand: HandoffDeps = { session: s.browser.session, now: () => s.clock.t, tabs: s.browser.tabs, scheme: SCHEME }
    const invokeId = uuid(321)
    const out = await stageInvoke(s.deps, { frame, binding, invokeId, method: 'createAction', params: { secret: 'x' } })
    await triggerHandoff(hand, 1)
    const url = s.browser.tabs.updates[0].url as string
    const scheme = SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(url).toMatch(new RegExp(`^${scheme}://bridge\\?v=1&n=[0-9a-f]{16}$`))
    if (out.kind === 'staged') expect(url).not.toContain(out.recordId)
    expect(url).not.toContain(invokeId)
    expect(url).not.toContain('app.example')
    expect(url).not.toContain('secret')
  })

  it('the nonce differs between triggers', async () => {
    const { browser, clock, deps } = handoffSetup()
    await triggerHandoff(deps, 1)
    clock.t += HANDOFF_COALESCE_MS
    await triggerHandoff(deps, 1)
    const [a, b] = browser.tabs.updates.map(u => u.url)
    expect(a).not.toBe(b)
  })

  it('a failing tabs.update releases the window so the next call retries', async () => {
    const { browser, deps } = handoffSetup()
    browser.tabs.failUpdate = true
    await expect(triggerHandoff(deps, 1)).resolves.toBeUndefined()
    browser.tabs.failUpdate = false
    await triggerHandoff(deps, 1)
    expect(browser.tabs.updates).toHaveLength(1)
  })
})
