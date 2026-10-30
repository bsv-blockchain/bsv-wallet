import { connectionError, type ConnectionErrorCode } from '../../../core/bridge/protocol/connectionError'
import { STATUS, statusForConnectionError, type StatusKey } from '../../../core/bridge/loopback/status'

describe('status table (spec 6.6.2)', () => {
  it('status table row per 6.6.2', () => {
    const rows: [StatusKey, number][] = [
      ['ok', 200],
      ['noContent', 204],
      ['walletError', 400],
      ['protocolError', 400],
      ['notFound', 404],
      ['forbidden', 403],
      ['userCancelled', 403],
      ['launchProof', 403],
      ['methodNotAllowed', 405],
      ['providerChanged', 412],
      ['connectionClosed', 410],
      ['lengthRequired', 411],
      ['bodyTooLarge', 413],
      ['unsupportedMediaType', 415],
      ['resourceLimit', 429],
      ['notBuilt', 503],
      ['tooManyConnections', 503],
      ['oversizeResponse', 502],
      ['internal', 500]
    ]
    expect(Object.keys(STATUS).sort()).toEqual(rows.map(r => r[0]).sort())
    for (const [k, n] of rows) expect([k, STATUS[k]]).toEqual([k, n])
  })

  it('maps connection error codes', () => {
    const cases: [ConnectionErrorCode, number][] = [
      ['PROTOCOL_ERROR', 400],
      ['PROVIDER_CHANGED', 412],
      ['CONNECTION_CLOSED', 410],
      ['RESOURCE_LIMIT', 429],
      ['USER_CANCELLED', 403],
      ['CONFIGURATION_ERROR', 503]
    ]
    for (const [code, n] of cases) {
      expect([code, statusForConnectionError(connectionError(code, 'm', 'not-sent'))]).toEqual([code, n])
    }
  })

  it('situations override the code', () => {
    const rl = connectionError('RESOURCE_LIMIT', 'big', 'unknown')
    expect(statusForConnectionError(rl, 'oversizeResponse')).toBe(502)
    expect(statusForConnectionError(rl, 'bodyTooLarge')).toBe(413)
    const cfg = connectionError('CONFIGURATION_ERROR', 'proof', 'not-sent')
    expect(statusForConnectionError(cfg, 'launchProof')).toBe(403)
    expect(statusForConnectionError(cfg, 'internal')).toBe(500)
  })

  it('page-side codes are an internal error if they ever reach the server', () => {
    expect(statusForConnectionError(connectionError('DISCONNECTED', 'x', 'unknown'))).toBe(500)
  })
})
