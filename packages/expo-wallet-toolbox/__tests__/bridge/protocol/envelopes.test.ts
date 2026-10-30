import { connectionError } from '../../../core/bridge/protocol/connectionError'
import { parseXdmEnvelope, xdmClosed, xdmError, xdmResult } from '../../../core/bridge/protocol/envelopes'

const E = '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f'
const I = '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d'

describe('parseXdmEnvelope', () => {
  it('accepts the builders output', () => {
    expect(parseXdmEnvelope(xdmResult('inst', E, I, { ok: 1 }))).toBeDefined()
    expect(parseXdmEnvelope(xdmError('inst', E, I, connectionError('RESOURCE_LIMIT', 'm', 'not-sent')))).toBeDefined()
    expect(parseXdmEnvelope(xdmClosed('inst', E, 'revoked'))).toBeDefined()
  })

  it('rejects a result that also carries an error, bad versions, bad uuids and unknown types', () => {
    expect(parseXdmEnvelope({ ...xdmResult('inst', E, I, 1), error: {} })).toBeUndefined()
    expect(parseXdmEnvelope({ ...xdmResult('inst', E, I, 1), version: 2 })).toBeUndefined()
    expect(parseXdmEnvelope(xdmResult('inst', 'not-a-uuid', I, 1))).toBeUndefined()
    expect(parseXdmEnvelope({ type: 'brc185:other', version: 1 })).toBeUndefined()
    expect(parseXdmEnvelope(xdmClosed('inst', E, 'disconnected' as never))).toBeUndefined()
    expect(parseXdmEnvelope(null)).toBeUndefined()
    expect(parseXdmEnvelope([])).toBeUndefined()
  })
})
