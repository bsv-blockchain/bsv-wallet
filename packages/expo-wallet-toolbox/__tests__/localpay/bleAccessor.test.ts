/**
 * getLocalPayBleTransport() is the second never-throwing Nitro accessor in
 * react-native-localpay-transport (spec §1). A `null` from it silently floors
 * the payment flow to QR — the same masking that hid two shipped native bugs
 * (84cd96e, 0c75467) — so the accessor must (a) never throw, (b) cache its
 * answer, and (c) warn exactly once in __DEV__ when it swallows the error.
 *
 * The real module is loaded fresh per test (resetModules) with
 * react-native-nitro-modules replaced, because the accessor's cache is a
 * module-level variable.
 */
type Accessors = typeof import('react-native-localpay-transport')

function loadWithNitro(createHybridObject: jest.Mock): Accessors {
  jest.doMock('react-native-nitro-modules', () => ({ NitroModules: { createHybridObject } }))
  return jest.requireActual<Accessors>('react-native-localpay-transport')
}

describe('getLocalPayBleTransport', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    jest.resetModules()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    jest.dontMock('react-native-nitro-modules')
  })

  it('returns null, never throws, and warns once when the native object cannot be created', () => {
    const create = jest.fn((): unknown => {
      throw new Error('HybridObject "LocalPayBleTransport" is not registered')
    })
    const { getLocalPayBleTransport } = loadWithNitro(create)

    expect(() => getLocalPayBleTransport()).not.toThrow()
    expect(getLocalPayBleTransport()).toBeNull()
    expect(getLocalPayBleTransport()).toBeNull()

    expect(create).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[localpay] LocalPayBleTransport unavailable:',
      'HybridObject "LocalPayBleTransport" is not registered'
    )
  })

  it('returns the hybrid object and caches it when creation succeeds', () => {
    const ble = { isSupported: () => true, bluetoothState: () => 'unknown', nfcAvailable: () => false }
    const create = jest.fn((): unknown => ble)
    const { getLocalPayBleTransport } = loadWithNitro(create)

    expect(getLocalPayBleTransport()).toBe(ble)
    expect(getLocalPayBleTransport()).toBe(ble)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('LocalPayBleTransport')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps its cache separate from getLocalPayTransport', () => {
    const ble = { isSupported: () => true }
    const create = jest.fn((name: string): unknown => {
      if (name === 'LocalPayBleTransport') return ble
      throw new Error(`no ${name}`)
    })
    const { getLocalPayBleTransport, getLocalPayTransport } = loadWithNitro(create)

    expect(getLocalPayTransport()).toBeNull()
    expect(getLocalPayBleTransport()).toBe(ble)
    // The AWDL/Nearby accessor swallows silently by design; only the BLE one warns.
    expect(warn).not.toHaveBeenCalled()
  })
})
