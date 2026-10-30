import { isUuidV4 } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { STAGE_CHUNK_BYTES } from '../../shared/constants'
import { loadBindings, bindingKey } from '../../extension/src/lib/bindings'
import { sha256Hex } from '../../extension/src/lib/bytes'
import { loadUnresolved, saveUnresolved } from '../../extension/src/lib/limits'
import { retryWithdrawals, stageInvoke } from '../../extension/src/lib/stage'
import { loadWithdrawals } from '../../extension/src/lib/tabs'
import { bind, setup, uuid } from './stageHelpers'

const INVOKE = uuid(500)
const decode = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8'))
const stagedOps = (ops: { op: string }[]) => ops.map(o => o.op).filter(o => o.startsWith('stage'))

describe('stageInvoke', () => {
  it('record ids are extension-minted and never the page invoke id', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const out = await stageInvoke(s.deps, {
      frame,
      binding,
      invokeId: INVOKE,
      method: 'createAction',
      params: { a: 1 }
    })
    expect(out.kind).toBe('staged')
    if (out.kind !== 'staged') return
    expect(isUuidV4(out.recordId)).toBe(true)
    expect(out.recordId).not.toBe(INVOKE)
    expect([...s.appex.records.keys()]).toEqual([out.recordId])
    const record = decode(s.appex.records.get(out.recordId)!.bytes)
    expect(record).toEqual({
      v: 1,
      id: out.recordId,
      kind: 'invoke',
      epoch: binding.epoch,
      instanceId: binding.instanceId,
      continuityKey: 'k',
      origin: binding.origin,
      accountContext: 'ctx-a',
      walletRevision: '5',
      boundAt: binding.boundAt,
      method: 'createAction',
      args: { a: 1 },
      createdAt: s.clock.t,
      notAfter: s.clock.t + 15 * 60 * 1000
    })
  })

  it('repeat invoke id reuses the mapping and does not stage again', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const args = { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} }
    const a = await stageInvoke(s.deps, args)
    s.clock.t += 500
    const b = await stageInvoke(s.deps, args)
    expect(b).toEqual(a)
    expect(s.appex.records.size).toBe(1)
    expect(stagedOps(s.appex.requests)).toEqual(['stage'])
  })

  it('repeat invoke after background reload does not stage twice', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const args = { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} }
    const a = await stageInvoke(s.deps, args)
    // The background unloads after the stage was acknowledged and before the reply reached the page: all
    // module state is gone, `storage.session` survives. A fresh deps object stands in for the new context.
    const reloaded = { ...s.deps, newId: () => uuid(9000) }
    const b = await stageInvoke(reloaded, args)
    expect(b).toEqual(a)
    expect(s.appex.records.size).toBe(1)
    expect(stagedOps(s.appex.requests)).toEqual(['stage'])
  })

  it('a stage the background died in the middle of is re-staged with the same id and digest', async () => {
    const s = setup()
    const { binding, frame } = await bind(s, 1)
    const args = { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} }
    const first = await stageInvoke(s.deps, args)
    if (first.kind !== 'staged') throw new Error('setup')
    // Pretend the reply and the `staged` mark were lost: the table says `staging`, the appex has the record.
    const table = await loadUnresolved(s.browser.session)
    table[first.recordId].state = 'staging'
    await saveUnresolved(s.browser.session, table)
    s.clock.t += 5000 // a new createdAt would change the digest; the stored one must be reused
    const again = await stageInvoke(s.deps, args)
    expect(again).toEqual(first)
    expect(s.appex.records.size).toBe(1)
    expect(s.appex.requests.filter(r => r.op === 'stage')).toHaveLength(2)
    expect(s.appex.requests.filter(r => r.op === 'stage').map(r => (r as { id: string }).id)).toEqual([
      first.recordId,
      first.recordId
    ])
    expect((await loadUnresolved(s.browser.session))[first.recordId].state).toBe('staged')
  })

  it('idempotent retry: same id same digest is exists, other digest is an error', async () => {
    const s = setup()
    const bytes = Buffer.from('{"v":1}').toString('base64')
    await expect(s.deps.native.stage(uuid(7), bytes)).resolves.toMatchObject({ status: 'created' })
    await expect(s.deps.native.stage(uuid(7), bytes)).resolves.toMatchObject({ status: 'exists' })
    await expect(s.deps.native.stage(uuid(7), Buffer.from('{"v":2}').toString('base64'))).rejects.toMatchObject({
      domain: 'brc185',
      code: 'PROTOCOL_ERROR',
      cause: 'EXISTS_DIFFERENT'
    })
    // And through stageInvoke: the first reply is lost, the retry sees `exists`, the call is staged once.
    const { binding, frame } = await bind(s, 1)
    s.appex.failNext = { stage: 1 }
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} })
    expect(out.kind).toBe('staged')
    expect(s.appex.records.size).toBe(2)
    expect(s.appex.requests.filter(r => r.op === 'stage')).toHaveLength(5) // 3 direct calls, then 2 attempts
  })

  it('withdraw wins: not-sent CONFIGURATION_ERROR', async () => {
    const s = setup({ dropReply: new Set(['stage']) })
    const { binding, frame } = await bind(s, 1)
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} })
    expect(out).toMatchObject({
      kind: 'error',
      error: { domain: 'brc185', code: 'CONFIGURATION_ERROR', delivery: 'not-sent' }
    })
    const [rec] = [...s.appex.records.values()]
    expect(rec.state).toBe('withdrawn')
    expect(await loadUnresolved(s.browser.session)).toEqual({})
    expect(await loadWithdrawals(s.browser.session)).toEqual([])
  })

  it('withdraw loses: keeps waiting', async () => {
    const s = setup({ dropReply: new Set(['stage']), autoAccept: true })
    const { binding, frame } = await bind(s, 1)
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} })
    expect(out.kind).toBe('staged')
    if (out.kind !== 'staged') return
    expect((await loadUnresolved(s.browser.session))[out.recordId]).toMatchObject({ state: 'staged' })
    expect(s.appex.records.get(out.recordId)!.state).toBe('accepted')
  })

  it('withdraw unconfirmed: CONNECTION_CLOSED unknown and id kept in closing', async () => {
    const s = setup({ dropReply: new Set(['stage']), dropRequest: new Set(['withdraw']) })
    const { binding, frame } = await bind(s, 1)
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} })
    expect(out).toMatchObject({
      kind: 'error',
      error: { domain: 'brc185', code: 'CONNECTION_CLOSED', delivery: 'unknown' }
    })
    const [id] = [...s.appex.records.keys()]
    expect(await loadWithdrawals(s.browser.session)).toEqual([id])
    expect(await loadUnresolved(s.browser.session)).toEqual({})
    // The next wake withdraws it.
    s.appex.dropRequest.clear()
    await retryWithdrawals(s.deps)
    expect(s.appex.records.get(id)!.state).toBe('withdrawn')
    expect(await loadWithdrawals(s.browser.session)).toEqual([])
  })

  it('a typed failure stages nothing and does not withdraw', async () => {
    const s = setup({ keyMissing: true })
    const { binding, frame } = await bind(s, 1)
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} })
    expect(out).toMatchObject({
      kind: 'error',
      error: { code: 'CONFIGURATION_ERROR', delivery: 'not-sent', cause: 'KEY_MISSING' }
    })
    expect(s.appex.requests.map(r => r.op)).toEqual(['stage'])
    expect(await loadUnresolved(s.browser.session)).toEqual({})
  })

  it('a failure before stageEnd created nothing: not-sent without a withdraw', async () => {
    const s = setup({ dropRequest: new Set(['stageChunk']) })
    const { binding, frame } = await bind(s, 1)
    const big = { p: 'x'.repeat(STAGE_CHUNK_BYTES * 2) }
    const out = await stageInvoke(s.deps, { frame, binding, invokeId: INVOKE, method: 'createAction', params: big })
    expect(out).toMatchObject({ kind: 'error', error: { code: 'CONFIGURATION_ERROR', delivery: 'not-sent' } })
    expect(s.appex.requests.some(r => r.op === 'withdraw')).toBe(false)
    expect(s.appex.records.size).toBe(0)
    expect(await loadUnresolved(s.browser.session)).toEqual({})
  })

  describe('chunking at STAGE_CHUNK_BYTES', () => {
    const run = async (pad: number) => {
      const s = setup()
      const { binding, frame } = await bind(s, 1)
      const out = await stageInvoke(s.deps, {
        frame,
        binding,
        invokeId: INVOKE,
        method: 'createAction',
        params: { p: 'x'.repeat(pad) }
      })
      if (out.kind !== 'staged') throw new Error(JSON.stringify(out))
      return { s, rec: s.appex.records.get(out.recordId)! }
    }

    it('n-1, n, n+1 rejoin to the same digest', async () => {
      const base = (await run(0)).rec.bytes.length
      for (const target of [STAGE_CHUNK_BYTES - 1, STAGE_CHUNK_BYTES, STAGE_CHUNK_BYTES + 1]) {
        const { s, rec } = await run(target - base)
        expect(rec.bytes.length).toBe(target)
        expect(rec.digest).toBe(sha256Hex(rec.bytes))
        expect(decode(rec.bytes).args.p).toHaveLength(target - base)
        const ops = stagedOps(s.appex.requests)
        if (target <= STAGE_CHUNK_BYTES) expect(ops).toEqual(['stage'])
        else {
          expect(ops).toEqual(['stageBegin', 'stageChunk', 'stageChunk', 'stageEnd'])
          const begin = s.appex.requests.find(r => r.op === 'stageBegin') as {
            size: number
            digest: string
            parts: number
          }
          expect(begin).toMatchObject({ size: target, digest: rec.digest, parts: 2 })
          const chunks = s.appex.requests.filter(r => r.op === 'stageChunk') as { n: number }[]
          expect(chunks.map(c => c.n)).toEqual([0, 1])
        }
      }
    })

    it('a multi-chunk record is retried with the same digest after a lost stageEnd reply', async () => {
      const s = setup({ failNext: { stageEnd: 1 } })
      const { binding, frame } = await bind(s, 1)
      const out = await stageInvoke(s.deps, {
        frame,
        binding,
        invokeId: INVOKE,
        method: 'createAction',
        params: { p: 'x'.repeat(STAGE_CHUNK_BYTES * 3) }
      })
      expect(out.kind).toBe('staged')
      expect(s.appex.records.size).toBe(1)
    })
  })

  describe('refused before staging', () => {
    it('a malformed call, a foreign frame and a closed connection', async () => {
      const s = setup()
      const { binding, frame } = await bind(s, 1)
      const base = { frame, binding, invokeId: INVOKE, method: 'getHeight', params: {} }
      const cases = [
        { ...base, invokeId: 'not-a-uuid' },
        { ...base, method: '' },
        { ...base, frame: { ...frame, origin: 'https://other.example' } },
        { ...base, frame: { ...frame, tabId: 99 } },
        { ...base, frame: { ...frame, frameId: 3 } },
        { ...base, params: () => 1 }
      ]
      for (const c of cases) {
        expect(await stageInvoke(s.deps, c)).toMatchObject({
          kind: 'error',
          error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' }
        })
      }
      const cyc: Record<string, unknown> = {}
      cyc.self = cyc
      expect(await stageInvoke(s.deps, { ...base, params: cyc })).toMatchObject({ error: { code: 'PROTOCOL_ERROR' } })
      expect(s.appex.requests).toHaveLength(0)

      // The epoch was closed by reconcile (logout, revoke): the binding is gone.
      const held = await loadBindings(s.browser.session)
      delete held[bindingKey(binding.instanceId, binding.epoch)]
      await s.browser.session.set({ 'bsv.bindings': held })
      expect(await stageInvoke(s.deps, base)).toMatchObject({
        kind: 'error',
        error: { code: 'CONNECTION_CLOSED', delivery: 'not-sent', epoch: binding.epoch }
      })
      expect(s.appex.requests).toHaveLength(0)
    })
  })
})
