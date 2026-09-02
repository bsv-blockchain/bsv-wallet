/**
 * Device capability probing for the payee's session QR hint bits (spec §4).
 *
 * This file is populated in Task 6 (DeviceProbe, capsFromProbe,
 * probeDeviceCaps). Only the BluetoothState type lives here for now, because
 * transport/select.ts's describeFloor() needs it for the payer's floor copy
 * and the type belongs beside the probe that produces it.
 */

/**
 * The five states LocalPayBleTransport.bluetoothState() can report. Prompt-free
 * on both platforms: iOS reads CBManager.authorization without instantiating a
 * manager, Android reads BluetoothAdapter.isEnabled(). Anything the native
 * string does not match is coerced to 'unsupported' by the probe.
 */
export type BluetoothState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'
