import { connectionError } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'
import { loadBindings } from '../../extension/src/lib/bindings'
import { loadUnresolved } from '../../extension/src/lib/limits'
import { pickup } from '../../extension/src/lib/pickup'
import { stageInvoke } from '../../extension/src/lib/stage'
import { makeMirror } from './fakeBrowser'
import { bind, setup, uuid, type Setup } from './stageHelpers'

const enc = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v), 'utf8'))

async function stageCall(s: Setup, tab: number, n: number) {
  const { binding, frame } = await bind(s, tab)
  const out = await stageInvoke(s.deps, { frame, binding, invokeId: uuid(800 + n), method: 'getHeight', params: {} })
  if (out.kind !== 'staged') throw new Error(JSON.stringify(out))
  return { id: out.recordId, binding }
}

describe('pickup', () => {
  it('result conversion: ok, wallet error and ConnectionError unchanged', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    const b = await stageCall(s, 2, 2)
    const c = await stageCall(s, 3, 3)
    const walletError = { code: 6, message: 'Insufficient funds', data: { needed: 5 } }
    const connError = connectionError('PROVIDER_CHANGED', 'The account changed', 'not-sent', { epoch: c.binding.epoch })
    s.appex.resultBytes.set(a.id, enc({ v: 1, id: a.id, ok: true, result: { height: 7, nested: [1, { x: null }] } }))
    s.appex.resultBytes.set(b.id, enc({ v: 1, id: b.id, ok: false, error: walletError }))
    s.appex.resultBytes.set(c.id, enc({ v: 1, id: c.id, ok: false, error: connError }))

    const items = await pickup(s.deps, [a.id, b.id, c.id])
    expect(items).toEqual([
      { id: a.id, kind: 'result', result: { height: 7, nested: [1, { x: null }] } },
      { id: b.id, kind: 'error', error: walletError },
      { id: c.id, kind: 'error', error: connError }
    ])
    expect(s.appex.acked.sort()).toEqual([a.id, b.id, c.id].sort())
    expect(await loadUnresolved(s.browser.session)).toEqual({})
  })

  it('a result that is still missing leaves the call waiting', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    expect(await pickup(s.deps, [a.id])).toEqual([])
    expect(Object.keys(await loadUnresolved(s.browser.session))).toEqual([a.id])
    expect(s.appex.acked).toEqual([])
  })

  it('purged result converts to unknown', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    s.appex.purged.add(a.id)
    const items = await pickup(s.deps, [a.id])
    expect(items).toEqual([
      {
        id: a.id,
        kind: 'error',
        error: {
          domain: 'brc185',
          code: 'CONNECTION_CLOSED',
          message: 'The result is no longer available',
          delivery: 'unknown'
        }
      }
    ])
    expect(await loadUnresolved(s.browser.session)).toEqual({})
  })

  it('in-flight call when mirror becomes absent rejects unknown', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    // Logout / Delete Wallet reset the container: the mirror, the queue and any result are gone.
    s.appex.mirrorState = 'absent'
    s.appex.mirror = undefined
    const items = await pickup(s.deps, [a.id])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: a.id,
      kind: 'error',
      error: { domain: 'brc185', code: 'CONNECTION_CLOSED', delivery: 'unknown' }
    })
    expect(await loadUnresolved(s.browser.session)).toEqual({})
    // reconcile closed the epoch lost on the way
    expect(await loadBindings(s.browser.session)).toEqual({})
    expect(s.deps.closedLog).toMatchObject([{ reason: 'lost' }])
  })

  it('a corrupt mirror counts as absent for waiting calls', async () => {
    const s = setup({ mirrorState: 'corrupt' })
    const a = await stageCall(s, 1, 1)
    const items = await pickup(s.deps, [a.id])
    expect(items[0]).toMatchObject({ kind: 'error', error: { code: 'CONNECTION_CLOSED', delivery: 'unknown' } })
  })

  it('second result for a resolved id is ignored and re-acked', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    const res = enc({ v: 1, id: a.id, ok: true, result: { height: 1 } })
    s.appex.resultBytes.set(a.id, res)
    expect(await pickup(s.deps, [a.id])).toHaveLength(1)
    // The ack did not stick (or a second poll raced): the app still has the result.
    s.appex.resultBytes.set(a.id, res)
    expect(await pickup(s.deps, [a.id])).toEqual([])
    expect(s.appex.acked.filter(x => x === a.id)).toHaveLength(2)
    expect(s.appex.resultBytes.has(a.id)).toBe(false)
  })

  it('two polls racing deliver once', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    s.appex.resultBytes.set(a.id, enc({ v: 1, id: a.id, ok: true, result: 1 }))
    const [x, y] = await Promise.all([pickup(s.deps, [a.id]), pickup(s.deps, [a.id])])
    expect(x.length + y.length).toBe(1)
  })

  it('reassembles a result that arrives in parts', async () => {
    const s = setup()
    s.appex.partBytes = 16
    const a = await stageCall(s, 1, 1)
    const result = { blob: 'y'.repeat(200), n: 3 }
    s.appex.resultBytes.set(a.id, enc({ v: 1, id: a.id, ok: true, result }))
    expect(await pickup(s.deps, [a.id])).toEqual([{ id: a.id, kind: 'result', result }])
    expect(s.appex.requests.filter(r => r.op === 'results').length).toBeGreaterThan(2)
  })

  it('a result that cannot be read, or names another id, is CONNECTION_CLOSED unknown', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    const b = await stageCall(s, 2, 2)
    s.appex.resultBytes.set(a.id, new Uint8Array(Buffer.from('not json')))
    s.appex.resultBytes.set(b.id, enc({ v: 1, id: uuid(9), ok: true, result: 1 }))
    const items = await pickup(s.deps, [a.id, b.id])
    expect(items.map(i => i.kind)).toEqual(['error', 'error'])
    expect(items[0]).toMatchObject({ error: { code: 'CONNECTION_CLOSED', delivery: 'unknown' } })
  })

  it('a native failure rejects and leaves every call waiting', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    s.appex.down = true
    await expect(pickup(s.deps, [a.id])).rejects.toMatchObject({ domain: 'brc185', delivery: 'not-sent' })
    expect(Object.keys(await loadUnresolved(s.browser.session))).toEqual([a.id])
  })

  it('results already read survive a failing reconcile', async () => {
    const s = setup()
    const a = await stageCall(s, 1, 1)
    s.appex.resultBytes.set(a.id, enc({ v: 1, id: a.id, ok: true, result: 5 }))
    s.appex.failNext = { sync: 3 }
    expect(await pickup(s.deps, [a.id])).toEqual([{ id: a.id, kind: 'result', result: 5 }])
  })

  it('a ready mirror with a waiting call keeps waiting', async () => {
    const s = setup({ mirrorState: 'ok', mirror: makeMirror() })
    const a = await stageCall(s, 1, 1)
    expect(await pickup(s.deps, [a.id])).toEqual([])
    expect(await pickup(s.deps, [])).toEqual([])
  })
})
