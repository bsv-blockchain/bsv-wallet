import { WERR_INSUFFICIENT_FUNDS, WERR_INVALID_PARAMETER } from '@bsv/sdk'
import { BRIDGE_METHODS } from '../../../core/bridge/protocol/methods'
import { MAX_BRIDGE_REQUEST_BYTES } from '../../../core/bridge/protocol/limits'
import { connectionError } from '../../../core/bridge/protocol/connectionError'
import { encodeWalletError } from '../../../core/bridge/protocol/errorCodec'
import {
  TRANSPORT_INDEPENDENT_CASES,
  type CaseContext,
  type HttpResult,
  type Outcome
} from '../../../core/bridge/testing/conformanceCases'

function throwFor(kind: string): never {
  switch (kind) {
    case 'invalid-parameter':
      throw new WERR_INVALID_PARAMETER('x', 'valid')
    case 'insufficient-funds':
      throw new WERR_INSUFFICIENT_FUNDS(10, 5)
    case 'hmac':
      throw Object.assign(new Error('bad hmac'), { code: 'ERR_INVALID_HMAC' })
    case 'signature':
      throw Object.assign(new Error('bad sig'), { code: 'ERR_INVALID_SIGNATURE' })
    default:
      throw new Error('boom')
  }
}

/** An in-memory executor that honours the contract documented in conformanceCases.ts. */
function good(): CaseContext {
  return {
    async call(method, args): Promise<Outcome> {
      if (JSON.stringify(args).length > MAX_BRIDGE_REQUEST_BYTES) {
        return { ok: false, connectionError: connectionError('RESOURCE_LIMIT', 'Request too large', 'not-sent') }
      }
      const a = args as { __fail?: string; __respondBytes?: number }
      try {
        if (a.__fail !== undefined) throwFor(a.__fail)
        if (a.__respondBytes !== undefined) {
          if (a.__respondBytes > MAX_BRIDGE_REQUEST_BYTES) {
            return { ok: false, connectionError: connectionError('RESOURCE_LIMIT', 'Response too large', 'unknown') }
          }
          return { ok: true, result: 'x'.repeat(a.__respondBytes) }
        }
        return { ok: true, result: { echo: method } }
      } catch (e) {
        return { ok: false, walletError: encodeWalletError(e), delivery: 'not-sent' }
      }
    }
  }
}

/** Breaks the codec (everything is code 1) and drops both caps. */
function broken(): CaseContext {
  const g = good()
  return {
    async call(method, args) {
      const a = args as { __fail?: string; __respondBytes?: number }
      if (a.__fail !== undefined)
        return { ok: false, walletError: encodeWalletError(new Error('boom')), delivery: 'not-sent' }
      if (a.__respondBytes !== undefined) return { ok: true, result: 'x'.repeat(Math.min(a.__respondBytes, 10)) }
      if (JSON.stringify(args).length > 1_000_000) return { ok: true, result: { echo: method } }
      return g.call(method, args)
    }
  }
}

/** The same good executor behind an HTTP-shaped responder. */
function http(): CaseContext {
  const g = good()
  return {
    async call(method, args): Promise<HttpResult> {
      const o = await g.call(method, args)
      if ('ok' in o && o.ok) return { status: 200, headers: [], body: JSON.stringify(o.result) }
      if ('walletError' in o) return { status: 200, headers: [], body: JSON.stringify(o.walletError) }
      if ('connectionError' in o) return { status: 413, headers: [], body: JSON.stringify(o.connectionError) }
      throw new Error('unreachable')
    }
  }
}

describe('transport-independent conformance cases', () => {
  it('28 method cases derived from BRIDGE_METHODS', () => {
    const m = TRANSPORT_INDEPENDENT_CASES.filter(c => c.method !== undefined)
    expect(m).toHaveLength(28)
    expect(m.map(c => c.method).sort()).toEqual(Object.keys(BRIDGE_METHODS).sort())
  })

  it('case ids are unique', () => {
    const ids = TRANSPORT_INDEPENDENT_CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every case passes against a trivial in-memory executor that honours the contract', async () => {
    const ctx = good()
    for (const c of TRANSPORT_INDEPENDENT_CASES) await expect(c.run(ctx)).resolves.toBeUndefined()
  })

  it('every case also passes through an HTTP-shaped responder', async () => {
    const ctx = http()
    for (const c of TRANSPORT_INDEPENDENT_CASES) await expect(c.run(ctx)).resolves.toBeUndefined()
  })

  it('the error-codec and size-cap cases fail against a deliberately broken executor', async () => {
    const ctx = broken()
    const failing: string[] = []
    for (const c of TRANSPORT_INDEPENDENT_CASES) {
      try {
        await c.run(ctx)
      } catch {
        failing.push(c.id)
      }
    }
    expect(failing).toEqual(
      expect.arrayContaining([
        'error-codec:invalid-parameter',
        'error-codec:insufficient-funds',
        'error-codec:hmac',
        'error-codec:signature',
        'request-cap:over',
        'response-cap:over'
      ])
    )
    expect(failing).not.toContain('error-codec:unknown')
    expect(failing.filter(id => id.startsWith('method:'))).toHaveLength(0)
  })
})
