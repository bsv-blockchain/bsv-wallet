// deviceCaps.ts imports NetInfo at module scope for probeDeviceCaps; this file
// never calls it, but the module must still load. Both import shapes are
// covered so the mock survives a default OR a named import in deviceCaps.ts.
jest.mock('@react-native-community/netinfo', () => {
  const netinfo = {
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true, type: 'wifi', isWifiEnabled: true }))
  }
  return { __esModule: true, default: netinfo, fetch: netinfo.fetch }
})

jest.mock('@bsv/react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(() => null),
  getLocalPayBleTransport: jest.fn(() => null)
}))

import { BLE_PREPARE_TIMEOUT_MS, prepareBle } from '../../core/localpay/deviceCaps'

const { getLocalPayBleTransport } = jest.requireMock('@bsv/react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

function fakeBle(overrides: { bluetoothState?: () => string; prepare?: (timeoutMs: number) => Promise<string> } = {}) {
  return {
    isSupported: () => true,
    nfcAvailable: () => false,
    bluetoothState: overrides.bluetoothState ?? (() => 'poweredOn'),
    prepare: jest.fn(overrides.prepare ?? (async () => 'poweredOn')),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    confirmFrame: jest.fn(),
    sendFrame: jest.fn()
  }
}

describe('prepareBle', () => {
  afterEach(() => jest.clearAllMocks())

  it('resolves the settled state and passes the default budget to native', async () => {
    const ble = fakeBle()
    getLocalPayBleTransport.mockReturnValue(ble)
    await expect(prepareBle()).resolves.toBe('poweredOn')
    expect(ble.prepare).toHaveBeenCalledWith(BLE_PREPARE_TIMEOUT_MS)
  })

  it('passes an explicit budget through', async () => {
    const ble = fakeBle({ prepare: async () => 'unauthorized' })
    getLocalPayBleTransport.mockReturnValue(ble)
    await expect(prepareBle(250)).resolves.toBe('unauthorized')
    expect(ble.prepare).toHaveBeenCalledWith(250)
  })

  it('resolves unsupported without touching native when there is no BLE HybridObject', async () => {
    getLocalPayBleTransport.mockReturnValue(null)
    await expect(prepareBle()).resolves.toBe('unsupported')
  })

  it('coerces an unrecognised native string to unknown', async () => {
    getLocalPayBleTransport.mockReturnValue(fakeBle({ prepare: async () => 'resetting' }))
    await expect(prepareBle()).resolves.toBe('unknown')
  })

  it('never rejects: a native rejection reads as unknown', async () => {
    getLocalPayBleTransport.mockReturnValue(
      fakeBle({
        prepare: async () => {
          throw new Error('managers never settled')
        }
      })
    )
    await expect(prepareBle()).resolves.toBe('unknown')
  })
})
