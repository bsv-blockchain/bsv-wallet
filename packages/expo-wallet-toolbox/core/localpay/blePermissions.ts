/**
 * The runtime grants the BLE rung needs, by API level. This is the Bluetooth-
 * only subset of what Nearby Connections asks for: no NEARBY_WIFI_DEVICES,
 * because bsvpay-ble/1 is plain GATT and never touches Wi-Fi. Requested
 * lazily — the payee on entering the nearby flow when Google Play services is
 * absent, the payer inside executeSend only when BLE was selected — never at
 * app start. A denial is a soft degrade to the QR fountain, not an error.
 *
 * iOS has no runtime request API for Bluetooth: the system prompt fires the
 * first time a CB*Manager is instantiated (prepare() / sendFrame), so this
 * resolves false there without asking anything, exactly like the Nearby helper.
 */
import { PermissionsAndroid, Platform } from 'react-native'

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10)
  const wanted: string[] =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  try {
    const results = await PermissionsAndroid.requestMultiple(wanted as never)
    return wanted.every(p => results[p as keyof typeof results] === PermissionsAndroid.RESULTS.GRANTED)
  } catch {
    return false
  }
}
