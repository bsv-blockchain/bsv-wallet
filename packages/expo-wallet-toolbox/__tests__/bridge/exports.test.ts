jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import * as bridge from '../../core/bridge'

describe('core/bridge public exports (spec 6.15 item 1)', () => {
  const functions = [
    'createInboxProcessor',
    'inboxDigest',
    'resolveInboxResult',
    'createMemoryInboxStore',
    'dispatch',
    'getTransport',
    'onBindingClosed',
    'isBridgeHostAttached',
    'initBridgeRuntime',
    'getBindingRegistry',
    'registerSessionTeardown',
    'canonicalizeBridgeOrigin',
    'connectionError',
    'isConnectionError',
    'b64uEncode',
    'b64uDecode',
    'canonicalize',
    'parseStrictJson'
  ]
  it.each(functions)('exports %s as a function', name => {
    expect(typeof (bridge as Record<string, unknown>)[name]).toBe('function')
  })

  it('exports the protocol limit and method constants', () => {
    expect((bridge as Record<string, unknown>).MAX_BRIDGE_REQUEST_BYTES).toBeDefined()
    expect(bridge.ADMIN_ORIGINATOR).toBe('internal-admin.bsv-wallet.invalid')
  })

  it('registerSessionTeardown is the registry the wallet session uses', () => {
    const { registerSessionTeardown, runSessionTeardown } = require('../../core/context/sessionTeardown')
    expect(bridge.registerSessionTeardown).toBe(registerSessionTeardown)
    const seen: string[] = []
    const off = bridge.registerSessionTeardown(['rebuild'], r => {
      seen.push(r)
    })
    runSessionTeardown('rebuild')
    off()
    expect(seen).toEqual(['rebuild'])
  })
})
