import { WERR_INSUFFICIENT_FUNDS, WERR_INVALID_PARAMETER, WERR_REVIEW_ACTIONS } from '@bsv/sdk'
import { connectionError, isConnectionError } from '../../../core/bridge/protocol/connectionError'
import { decodeWireError, encodeWalletError } from '../../../core/bridge/protocol/errorCodec'

// Shaped like the toolbox WalletError family: `name` carries the WERR_ string and `code` is a
// string getter (never a number), which is why mapping must not use the truthiness of `code`.
class ToolboxError extends Error {
  isError = true
  constructor(name: string, message: string, fields: Record<string, unknown> = {}) {
    super(message)
    this.name = name
    Object.assign(this, fields)
  }
  get code() {
    return this.name
  }
}

describe('encodeWalletError', () => {
  it('maps SDK WERR_REVIEW_ACTIONS to 5 with its fields', () => {
    const e = new WERR_REVIEW_ACTIONS(
      [{ txid: 'aa', status: 'doubleSpend', competingTxs: ['bb'] } as never],
      [{ txid: 'aa', status: 'failed' } as never],
      'aa',
      [1, 2, 3],
      ['aa.0']
    )
    const w = encodeWalletError(e)
    expect(w).toMatchObject({
      isError: true,
      code: 5,
      reviewActionResults: [{ txid: 'aa', status: 'doubleSpend', competingTxs: ['bb'] }],
      sendWithResults: [{ txid: 'aa', status: 'failed' }],
      txid: 'aa',
      tx: [1, 2, 3],
      noSendChange: ['aa.0']
    })
    expect(w.data).toEqual({ originalName: e.name, originalCode: 5 })
  })

  it('maps a toolbox WERR_REVIEW_ACTIONS with a string code to 5', () => {
    const e = new ToolboxError('WERR_REVIEW_ACTIONS', 'review', {
      reviewActionResults: [],
      sendWithResults: [{ txid: 'cc', status: 'unproven' }],
      txid: 'cc'
    })
    const w = encodeWalletError(e)
    expect(w.code).toBe(5)
    expect(w.sendWithResults).toEqual([{ txid: 'cc', status: 'unproven' }])
    expect(w.txid).toBe('cc')
    expect(w.tx).toBeUndefined()
    expect(w.data).toEqual({ originalName: 'WERR_REVIEW_ACTIONS', originalCode: 'WERR_REVIEW_ACTIONS' })
  })

  it('maps WERR_INVALID_PARAMETER to 6 with its parameter', () => {
    const w = encodeWalletError(new WERR_INVALID_PARAMETER('basket', 'a string'))
    expect(w).toMatchObject({ code: 6, parameter: 'basket', name: 'WERR_INVALID_PARAMETER' })
  })

  it('maps toolbox WERR_INVALID_PARAMETER by name', () => {
    const w = encodeWalletError(new ToolboxError('WERR_INVALID_PARAMETER', 'bad', { parameter: 'labels' }))
    expect(w).toMatchObject({ code: 6, parameter: 'labels' })
  })

  it('supplies a parameter for code 6 errors that lack one', () => {
    class VaultAccessDenied extends Error {
      readonly code = 6
      constructor() {
        super('not permitted')
        this.name = 'VaultAccessDenied'
      }
    }
    class WalletArgTooLarge extends Error {
      readonly code = 6
      constructor(readonly field: string) {
        super('too big')
        this.name = 'WalletArgTooLarge'
      }
    }
    const a = encodeWalletError(new VaultAccessDenied())
    expect(a.code).toBe(6)
    expect(typeof a.parameter).toBe('string')
    expect((a.parameter as string).length).toBeGreaterThan(0)
    expect(encodeWalletError(new WalletArgTooLarge('outputs'))).toMatchObject({ code: 6, parameter: 'outputs' })
    const bare = Object.assign(new Error('x'), { code: 6 })
    expect(typeof encodeWalletError(bare).parameter).toBe('string')
  })

  it('maps WERR_INSUFFICIENT_FUNDS to 7', () => {
    expect(encodeWalletError(new WERR_INSUFFICIENT_FUNDS(1000, 250))).toMatchObject({
      code: 7,
      totalSatoshisNeeded: 1000,
      moreSatoshisNeeded: 250
    })
    expect(
      encodeWalletError(
        new ToolboxError('WERR_INSUFFICIENT_FUNDS', 'funds', { totalSatoshisNeeded: 9, moreSatoshisNeeded: 3 })
      )
    ).toMatchObject({ code: 7, totalSatoshisNeeded: 9, moreSatoshisNeeded: 3 })
  })

  it('maps invalid HMAC and signature string codes to 3 and 4', () => {
    expect(
      encodeWalletError(Object.assign(new Error('HMAC is not valid'), { code: 'ERR_INVALID_HMAC' }))
    ).toMatchObject({
      code: 3,
      message: 'HMAC is not valid'
    })
    expect(
      encodeWalletError(Object.assign(new Error('Signature is not valid'), { code: 'ERR_INVALID_SIGNATURE' }))
    ).toMatchObject({ code: 4 })
  })

  it('maps WERR_INVALID_MERKLE_ROOT to 1 and records the original name', () => {
    const w = encodeWalletError(new ToolboxError('WERR_INVALID_MERKLE_ROOT', 'bad root'))
    expect(w.code).toBe(1)
    expect(w.data).toMatchObject({ originalName: 'WERR_INVALID_MERKLE_ROOT' })
  })

  it('maps user denial and unknown values to 1 without a stack', () => {
    const w = encodeWalletError(new Error('User denied permission'))
    expect(w).toMatchObject({ isError: true, code: 1, message: 'User denied permission' })
    expect(JSON.stringify(w)).not.toContain('at ')
    expect('stack' in w).toBe(false)
    expect(encodeWalletError('boom')).toMatchObject({ code: 1, message: 'boom' })
    expect(encodeWalletError(undefined)).toMatchObject({ code: 1 })
    expect(encodeWalletError({ code: 99, message: 'odd' })).toMatchObject({ code: 1, message: 'odd' })
  })

  it('never reads a truthy string code as a wire code', () => {
    const w = encodeWalletError(new ToolboxError('WERR_UNAUTHORIZED', 'nope'))
    expect(w.code).toBe(1)
    expect(w.data).toEqual({ originalName: 'WERR_UNAUTHORIZED', originalCode: 'WERR_UNAUTHORIZED' })
  })

  it('caps the message at 4096 bytes without splitting a character', () => {
    const w = encodeWalletError(new Error('é'.repeat(5000)))
    expect(Buffer.byteLength(w.message)).toBeLessThanOrEqual(4096)
    expect(w.message).not.toContain('�')
    expect(w.message.length).toBeGreaterThan(0)
  })

  it('output is JSON-safe', () => {
    const w = encodeWalletError(new WERR_INVALID_PARAMETER('x', 'y'))
    expect(JSON.parse(JSON.stringify(w))).toEqual(w)
  })
})

describe('decodeWireError', () => {
  it('round-trips code 5, 6 and 7 into SDK classes', () => {
    const r = decodeWireError(
      encodeWalletError(new WERR_REVIEW_ACTIONS([], [{ txid: 'aa', status: 'unproven' }], 'aa', [9], ['aa.0']))
    ) as WERR_REVIEW_ACTIONS
    expect(r).toBeInstanceOf(WERR_REVIEW_ACTIONS)
    expect(r.sendWithResults).toEqual([{ txid: 'aa', status: 'unproven' }])
    expect(r.txid).toBe('aa')
    expect(r.tx).toEqual([9])
    expect(r.noSendChange).toEqual(['aa.0'])

    const p = decodeWireError(encodeWalletError(new WERR_INVALID_PARAMETER('basket', 'x'))) as WERR_INVALID_PARAMETER
    expect(p).toBeInstanceOf(WERR_INVALID_PARAMETER)
    expect(p.parameter).toBe('basket')

    const f = decodeWireError(encodeWalletError(new WERR_INSUFFICIENT_FUNDS(5, 2))) as WERR_INSUFFICIENT_FUNDS
    expect(f).toBeInstanceOf(WERR_INSUFFICIENT_FUNDS)
    expect([f.totalSatoshisNeeded, f.moreSatoshisNeeded]).toEqual([5, 2])
  })

  it('rebuilds codes 1, 3 and 4 as plain errors that keep the code', () => {
    const e = decodeWireError({ isError: true, code: 1, name: 'Error', message: 'denied' })
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('denied')
    expect((e as unknown as { isError: boolean }).isError).toBe(true)
    expect((e as unknown as { code: number }).code).toBe(1)
    expect((decodeWireError({ isError: true, code: 3, message: 'm' }) as unknown as { code: string }).code).toBe(
      'ERR_INVALID_HMAC'
    )
    expect((decodeWireError({ isError: true, code: 4, message: 'm' }) as unknown as { code: string }).code).toBe(
      'ERR_INVALID_SIGNATURE'
    )
  })

  it('applies the SDK bounds: malformed fields degrade to a plain error', () => {
    const bad = decodeWireError({ isError: true, code: 7, message: 'm', totalSatoshisNeeded: 'x' })
    expect(bad).not.toBeInstanceOf(WERR_INSUFFICIENT_FUNDS)
    expect(bad.message).toBe('m')
    const bad5 = decodeWireError({ isError: true, code: 5, message: 'm', reviewActionResults: 'no' })
    expect(bad5).not.toBeInstanceOf(WERR_REVIEW_ACTIONS)
    const bad6 = decodeWireError({ isError: true, code: 6, message: 'm' })
    expect(bad6).not.toBeInstanceOf(WERR_INVALID_PARAMETER)
  })

  it('rebuilds a ConnectionError as an Error carrying the brc185 fields', () => {
    const ce = connectionError('RESOURCE_LIMIT', 'too many', 'not-sent')
    const e = decodeWireError(ce) as unknown as Record<string, unknown>
    expect(e).toBeInstanceOf(Error)
    expect(e.domain).toBe('brc185')
    expect(e.code).toBe('RESOURCE_LIMIT')
    expect(e.delivery).toBe('not-sent')
    expect(isConnectionError(e)).toBe(true)
  })

  it('tolerates junk', () => {
    expect(decodeWireError(null)).toBeInstanceOf(Error)
    expect(decodeWireError('x')).toBeInstanceOf(Error)
    expect(decodeWireError({ code: {} })).toBeInstanceOf(Error)
  })
})

describe('connectionError', () => {
  it('builds the BRC-185 section 6 object', () => {
    expect(
      connectionError('PROVIDER_CHANGED', 'changed', 'not-sent', { epoch: 'e1', cause: 'account-changed' })
    ).toEqual({
      domain: 'brc185',
      code: 'PROVIDER_CHANGED',
      message: 'changed',
      delivery: 'not-sent',
      epoch: 'e1',
      cause: 'account-changed'
    })
  })

  it('omits absent optional fields and caps the message', () => {
    const ce = connectionError('PROTOCOL_ERROR', 'x'.repeat(9000), 'unknown')
    expect(Object.keys(ce).sort()).toEqual(['code', 'delivery', 'domain', 'message'])
    expect(Buffer.byteLength(ce.message)).toBeLessThanOrEqual(4096)
  })

  it('isConnectionError rejects wallet errors and junk', () => {
    expect(isConnectionError(new Error('x'))).toBe(false)
    expect(isConnectionError({ domain: 'brc185', code: 'NOPE', delivery: 'not-sent', message: 'm' })).toBe(false)
    expect(isConnectionError(null)).toBe(false)
  })
})
