import { PermissionsAndroid, Platform } from 'react-native'
import type { Permission, PermissionStatus } from 'react-native'
import { requestBlePermissions } from '../../core/localpay/blePermissions'

describe('requestBlePermissions', () => {
  // API >= 31: the three Bluetooth grants, in this order, and nothing else —
  // NEARBY_WIFI_DEVICES belongs to Nearby Connections, not to GATT.
  const BLE_31: Permission[] = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
  ]
  // API <= 30: BLE scanning is gated by fine location.
  const BLE_30: Permission[] = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]

  const grantedResult = (permissions: Permission[]): Partial<Record<Permission, PermissionStatus>> =>
    Object.fromEntries(permissions.map(p => [p, PermissionsAndroid.RESULTS.GRANTED]))

  afterEach(() => {
    Platform.OS = 'ios'
    jest.restoreAllMocks()
  })

  it('on API 33 requests exactly SCAN, CONNECT, ADVERTISE and resolves true when all granted', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_31) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toEqual(BLE_31)
    expect(spy.mock.calls[0][0]).not.toContain(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES)
  })

  it('on API 31 requests the same three Bluetooth grants', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(31)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_31) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy.mock.calls[0][0]).toEqual(BLE_31)
  })

  it('on API 30 requests only ACCESS_FINE_LOCATION', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(30)
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue(grantedResult(BLE_30) as never)

    await expect(requestBlePermissions()).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toEqual(BLE_30)
  })

  it('resolves false when one requested permission is denied', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      ...grantedResult(BLE_31),
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: PermissionsAndroid.RESULTS.DENIED
    } as never)

    await expect(requestBlePermissions()).resolves.toBe(false)
  })

  it('resolves false when requestMultiple throws', async () => {
    Platform.OS = 'android'
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(33)
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockRejectedValue(new Error('activity gone'))

    await expect(requestBlePermissions()).resolves.toBe(false)
  })

  it('resolves false on non-android platforms without requesting anything', async () => {
    Platform.OS = 'ios'
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as never)

    await expect(requestBlePermissions()).resolves.toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
