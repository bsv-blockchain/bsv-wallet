import { Platform } from 'react-native'
import { describeFloor, type FloorReason } from '../../core/localpay/transport/select'
import { mintSession, CAP_AWDL, CAP_BLE, CAP_NEARBY, HINT_BT, HINT_WIFI, type Session } from '../../core/localpay/session'

let mockIsSupported = true
let mockBleSupported = true

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => mockIsSupported }),
  getLocalPayBleTransport: () => ({
    isSupported: () => mockBleSupported,
    bluetoothState: () => 'poweredOn',
    nfcAvailable: () => false
  })
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: false
}

function session(caps: number, os?: 'ios' | 'android'): Session {
  return { ...mintSession(base), caps, ...(os === undefined ? {} : { os }) }
}

describe('describeFloor', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockIsSupported = true
    mockBleSupported = true
  })

  it('returns none when a radio rung is selected', () => {
    Platform.OS = 'ios'
    const reason: FloorReason = describeFloor(session(CAP_AWDL, 'ios'), { os: 'ios', bluetooth: 'poweredOn' })
    expect(reason).toBe('none')
  })

  it('peer_no_radio when the peer advertised hints but no rung at all', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(HINT_BT | HINT_WIFI, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe(
      'peer_no_radio'
    )
  })

  it('local_ble_denied when the peer advertises BLE and this app is unauthorized', () => {
    Platform.OS = 'ios'
    mockBleSupported = false
    expect(describeFloor(session(CAP_BLE | HINT_BT, 'android'), { os: 'ios', bluetooth: 'unauthorized' })).toBe(
      'local_ble_denied'
    )
  })

  it('local_bt_off when the peer advertises BLE and this radio is powered off', () => {
    Platform.OS = 'android'
    mockBleSupported = false
    expect(describeFloor(session(CAP_BLE | HINT_BT, 'ios'), { os: 'android', bluetooth: 'poweredOff' })).toBe(
      'local_bt_off'
    )
  })

  it('cross_os_no_ble when the peer is on the other OS with Bluetooth on but could not advertise BLE', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(CAP_NEARBY | HINT_BT, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe(
      'cross_os_no_ble'
    )
  })

  it('peer_bt_off when the peer has no BLE rung and its Bluetooth hint is clear', () => {
    Platform.OS = 'ios'
    expect(describeFloor(session(CAP_NEARBY, 'android'), { os: 'ios', bluetooth: 'poweredOn' })).toBe('peer_bt_off')
  })

  it('none when the peer has Bluetooth on, no BLE rung, and the OS is unknown or the same', () => {
    Platform.OS = 'ios'
    // OS unknown: cannot claim cross-OS
    expect(describeFloor(session(CAP_NEARBY | HINT_BT), { os: 'ios', bluetooth: 'poweredOn' })).toBe('none')
    // same OS, AWDL advertised but unusable locally: nothing on the table matches
    mockIsSupported = false
    expect(describeFloor(session(CAP_AWDL | HINT_BT, 'ios'), { os: 'ios', bluetooth: 'poweredOn' })).toBe('none')
  })
})
