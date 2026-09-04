import { PermissionsAndroid, Platform } from 'react-native'
import type { Permission, PermissionStatus } from 'react-native'
import { bleRole, localSupportsBle, selectTransport } from '../../core/localpay/transport/select'
import { mintSession, CAP_AWDL, CAP_BLE, CAP_BLE_SCAN, CAP_NEARBY, type Session } from '../../core/localpay/session'
import { requestNearbyPermissions } from '../../core/localpay/nearbyPermissions'

let mockIsSupported = true
let mockBleSupported = true
let mockBleState = 'poweredOn'
let mockBleAccessorNull = false
let mockBleThrows = false

jest.mock('@bsv/react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => mockIsSupported }),
  getLocalPayBleTransport: () =>
    mockBleAccessorNull
      ? null
      : {
          isSupported: () => {
            if (mockBleThrows) throw new Error('nitro boom')
            return mockBleSupported
          },
          bluetoothState: () => mockBleState,
          nfcAvailable: () => false
        }
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw'
}

describe('transport selection', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockIsSupported = true
    mockBleSupported = true
    mockBleState = 'poweredOn'
    mockBleAccessorNull = false
    mockBleThrows = false
  })

  it('uses AWDL when both sides support it', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('awdl')
  })

  it('falls back to QR when the payee cannot do AWDL', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: false }))).toBe('qr')
  })

  it('falls back to QR when the local device is Android', () => {
    Platform.OS = 'android'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('qr')
  })

  it('leaves the AWDL capability bit set only when advertised', () => {
    expect(mintSession({ ...base, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })

  // caps × platform × socket-native support × BLE-native support → transport
  const CASES: [
    caps: number,
    platform: 'ios' | 'android',
    nativeSocket: boolean,
    nativeBle: boolean,
    expected: string
  ][] = [
    [CAP_AWDL, 'ios', true, true, 'awdl'],
    [CAP_AWDL, 'ios', false, true, 'qr'],
    [CAP_AWDL, 'android', true, true, 'qr'], // AWDL cap useless off-iOS
    [CAP_NEARBY, 'android', true, true, 'nearby'],
    [CAP_NEARBY, 'android', false, true, 'qr'],
    [CAP_NEARBY, 'ios', true, true, 'qr'], // Nearby cap useless on iOS
    [CAP_AWDL | CAP_NEARBY, 'ios', true, true, 'awdl'], // AWDL outranks Nearby
    [CAP_AWDL | CAP_NEARBY, 'android', true, true, 'nearby'],
    [0, 'ios', true, true, 'qr'],
    [0, 'android', true, true, 'qr'],
    // BLE rung (spec §5): the one radio that exists on both platforms
    [CAP_BLE, 'ios', true, true, 'ble'],
    [CAP_BLE, 'android', true, true, 'ble'],
    [CAP_AWDL | CAP_BLE, 'android', true, true, 'ble'], // iOS payee, Android payer → BLE
    [CAP_NEARBY | CAP_BLE, 'ios', true, true, 'ble'], // Android payee, iOS payer → BLE
    [CAP_AWDL | CAP_NEARBY | CAP_BLE, 'ios', true, true, 'awdl'], // same-OS keeps the faster radio
    [CAP_AWDL | CAP_NEARBY | CAP_BLE, 'android', true, true, 'nearby'],
    [CAP_BLE, 'ios', true, false, 'qr'], // peer advertises BLE but this device cannot
    [CAP_AWDL | CAP_BLE, 'ios', false, true, 'ble'] // AWDL native unsupported → falls to BLE
  ]

  it.each(CASES)(
    'caps=%p platform=%s socket=%p ble=%p -> %s',
    (caps, platform, nativeSocket, nativeBle, expected) => {
      Platform.OS = platform
      mockIsSupported = nativeSocket
      mockBleSupported = nativeBle
      const session: Session = { ...mintSession({ ...base, supportsAwdl: false }), caps }
      expect(selectTransport(session)).toBe(expected)
    }
  )
})

describe('localSupportsBle', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockBleSupported = true
    mockBleAccessorNull = false
    mockBleThrows = false
  })

  it('is true on either OS when the native object reports support', () => {
    Platform.OS = 'android'
    expect(localSupportsBle()).toBe(true)
    Platform.OS = 'ios'
    expect(localSupportsBle()).toBe(true)
  })

  it('is false when the accessor returns null (no native module)', () => {
    mockBleAccessorNull = true
    expect(localSupportsBle()).toBe(false)
  })

  it('is false when the native probe throws', () => {
    mockBleThrows = true
    expect(localSupportsBle()).toBe(false)
  })
})

describe('requestNearbyPermissions', () => {
  const NEARBY_31: Permission[] = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
  ]

  const grantedResult = (permissions: Permission[]): Partial<Record<Permission, PermissionStatus>> =>
    Object.fromEntries(permissions.map(p => [p, PermissionsAndroid.RESULTS.GRANTED]))

  afterEach(() => {
    Platform.OS = 'ios'
    jest.restoreAllMocks()
  })

  it('resolves true when every requested permission lands granted', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(NEARBY_31) as never)

    await expect(requestNearbyPermissions()).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('resolves false when one requested permission is denied', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      ...grantedResult(NEARBY_31),
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: PermissionsAndroid.RESULTS.DENIED
    } as never)

    await expect(requestNearbyPermissions()).resolves.toBe(false)
  })

  it('resolves false on non-android platforms without requesting anything', async () => {
    Platform.OS = 'ios'
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as never)

    await expect(requestNearbyPermissions()).resolves.toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('bleRole', () => {
  afterEach(() => {
    Platform.OS = 'ios'
  })

  it('is peripheral only when the payee scans and this device is Android', () => {
    Platform.OS = 'android'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true, supportsBleScan: true }))).toBe('peripheral')
  })

  it('stays central on iOS even when the payee scans', () => {
    Platform.OS = 'ios'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true, supportsBleScan: true }))).toBe('central')
  })

  it('stays central on Android when the payee does not scan', () => {
    Platform.OS = 'android'
    expect(bleRole(mintSession({ ...base, supportsAwdl: false, supportsBle: true }))).toBe('central')
  })

  it('does not select BLE at all for a session carrying only the scan bit', () => {
    Platform.OS = 'android'
    const s: Session = { ...mintSession({ ...base, supportsAwdl: false }), caps: CAP_BLE_SCAN }
    expect(selectTransport(s)).toBe('qr')
  })
})
