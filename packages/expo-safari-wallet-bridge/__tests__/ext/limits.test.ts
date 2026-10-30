import { MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import { checkLimits, loadUnresolved, type UnresolvedEntry, type UnresolvedState } from '../../extension/src/lib/limits'
import { stageInvoke } from '../../extension/src/lib/stage'
import { bind, setup, uuid } from './stageHelpers'

const entry = (n: number, epoch: number, size = 10): UnresolvedEntry => ({
  recordId: uuid(n),
  instanceId: 'i',
  epoch: uuid(epoch),
  invokeId: uuid(n + 5000),
  tabId: epoch,
  size,
  state: 'staged',
  createdAt: 1
})
const table = (...es: UnresolvedEntry[]): UnresolvedState => Object.fromEntries(es.map(e => [e.recordId, e]))

describe('checkLimits', () => {
  it('4 per epoch, 16 overall, 5 MiB overall', () => {
    const b = { instanceId: 'i', epoch: uuid(1) }
    const four = table(entry(1, 1), entry(2, 1), entry(3, 1), entry(4, 1))
    expect(checkLimits(four, b, 1)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    expect(checkLimits(four, { instanceId: 'i', epoch: uuid(2) }, 1)).toBeUndefined()

    const sixteen = table(...Array.from({ length: 16 }, (_, i) => entry(i + 1, (i % 4) + 10)))
    expect(checkLimits(sixteen, { instanceId: 'i', epoch: uuid(99) }, 1)).toMatchObject({ code: 'RESOURCE_LIMIT' })

    const mib = 1024 * 1024
    const big = table(entry(1, 1, 3 * mib))
    expect(checkLimits(big, { instanceId: 'i', epoch: uuid(2) }, 2 * mib)).toBeUndefined()
    expect(checkLimits(big, { instanceId: 'i', epoch: uuid(2) }, 2 * mib + 1)).toMatchObject({
      code: 'RESOURCE_LIMIT',
      delivery: 'not-sent'
    })
  })
})

describe('limits through stageInvoke', () => {
  it('a batch of 16 across 4 tabs never produces RESOURCE_LIMIT from the app side while a 17th, a 5th in one epoch and a request over 5 MiB total are refused locally', async () => {
    const s = setup()
    // The app's dispatcher answers RESOURCE_LIMIT by itself when it is over 4/16 in flight; staging 16 must
    // therefore all be accepted by the extension and none refused.
    const tabs: Awaited<ReturnType<typeof bind>>[] = []
    for (const n of [1, 2, 3, 4, 5]) tabs.push(await bind(s, n))
    let k = 0
    const call = (i: number, params: unknown = {}) =>
      stageInvoke(s.deps, {
        frame: tabs[i].frame,
        binding: tabs[i].binding,
        invokeId: uuid(7000 + k++),
        method: 'getHeight',
        params
      })

    const first16 = []
    for (let t = 0; t < 4; t++) for (let j = 0; j < 4; j++) first16.push(await call(t))
    expect(first16.every(o => o.kind === 'staged')).toBe(true)
    expect(s.appex.records.size).toBe(16)

    const seventeenth = await call(4)
    expect(seventeenth).toMatchObject({ kind: 'error', error: { code: 'RESOURCE_LIMIT', delivery: 'not-sent' } })
    const fifth = await call(0)
    expect(fifth).toMatchObject({ kind: 'error', error: { code: 'RESOURCE_LIMIT', delivery: 'not-sent' } })
    expect(s.appex.records.size).toBe(16) // neither reached the appex
    expect(Object.keys(await loadUnresolved(s.browser.session))).toHaveLength(16)
  })

  it('a request over 5 MiB is refused locally; two that together pass 5 MiB refuse the second', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const over = await stageInvoke(s.deps, {
      frame,
      binding,
      invokeId: uuid(1),
      method: 'createAction',
      params: { p: 'x'.repeat(MAX_BRIDGE_REQUEST_BYTES) }
    })
    expect(over).toMatchObject({ kind: 'error', error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
    expect(s.appex.requests).toHaveLength(0)

    const half = 3 * 1024 * 1024
    const a = await stageInvoke(s.deps, {
      frame,
      binding,
      invokeId: uuid(2),
      method: 'createAction',
      params: { p: 'x'.repeat(half) }
    })
    expect(a.kind).toBe('staged')
    const before = s.appex.requests.length
    const b = await stageInvoke(s.deps, {
      frame,
      binding,
      invokeId: uuid(3),
      method: 'createAction',
      params: { p: 'x'.repeat(half) }
    })
    expect(b).toMatchObject({ kind: 'error', error: { code: 'RESOURCE_LIMIT', delivery: 'not-sent' } })
    expect(s.appex.requests).toHaveLength(before)
  })
})
