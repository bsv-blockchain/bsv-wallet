import { Platform } from 'react-native'
import {
  BLE_PREPARE_TIMEOUT_MS,
  DEFAULT_NET_BUDGET_MS,
  capsFromProbe,
  probeDeviceCaps,
  readBluetoothState,
  type DeviceProbe,
} from '../../core/localpay/deviceCaps'
import {
  CAP_AWDL,
  HINT_BT,
  HINT_NET,
  HINT_NFC,
  HINT_ONLINE,
  HINT_ONLINE_KNOWN,
  HINT_WIFI,
  RUNG_MASK,
  mintSession,
} from '../../core/localpay/session'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
  getLocalPayBleTransport: jest.fn(),
}))

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}))

const { getLocalPayBleTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayBleTransport: jest.Mock
}

const netFetch = (jest.requireMock('@react-native-community/netinfo') as { default: { fetch: jest.Mock } })
  .default.fetch

/** Every field in its "false or unknown" position: the probe that must map to 0. */
const clear: DeviceProbe = {
  online: null,
  connected: null,
  wifi: false,
  bluetooth: 'unknown',
  nfc: false,
}

const allSet: DeviceProbe = {
  online: true,
  connected: true,
  wifi: true,
  bluetooth: 'poweredOn',
  nfc: true,
}

const ALL_HINTS = HINT_ONLINE | HINT_ONLINE_KNOWN | HINT_NET | HINT_WIFI | HINT_BT | HINT_NFC

const wifiState = {
  isInternetReachable: true,
  isConnected: true,
  type: 'wifi',
  isWifiEnabled: true,
}

describe('capsFromProbe', () => {
  // One field flipped away from `clear` at a time, then the two extremes.
  // A reachable internet implies the probe answered, so HINT_ONLINE never
  // appears without HINT_ONLINE_KNOWN — that pair is the "bit alone" case.
  const TABLE: [name: string, probe: DeviceProbe, expected: number][] = [
    ['online true', { ...clear, online: true }, HINT_ONLINE | HINT_ONLINE_KNOWN],
    ['online false', { ...clear, online: false }, HINT_ONLINE_KNOWN],
    ['online null', { ...clear, online: null }, 0],
    ['connected true', { ...clear, connected: true }, HINT_NET],
    ['connected false', { ...clear, connected: false }, 0],
    ['wifi', { ...clear, wifi: true }, HINT_WIFI],
    ['bluetooth poweredOn', { ...clear, bluetooth: 'poweredOn' }, HINT_BT],
    ['bluetooth poweredOff', { ...clear, bluetooth: 'poweredOff' }, 0],
    ['bluetooth unauthorized', { ...clear, bluetooth: 'unauthorized' }, 0],
    ['bluetooth unsupported', { ...clear, bluetooth: 'unsupported' }, 0],
    ['bluetooth unknown', { ...clear, bluetooth: 'unknown' }, 0],
    ['nfc', { ...clear, nfc: true }, HINT_NFC],
    ['all set', allSet, ALL_HINTS],
    ['all clear', clear, 0],
  ]

  it.each(TABLE)('%s', (_name, probe, expected) => {
    expect(capsFromProbe(probe)).toBe(expected)
  })

  it.each(TABLE)('%s never touches a rung bit', (_name, probe) => {
    expect(capsFromProbe(probe) & RUNG_MASK).toBe(0)
  })

  it('all six hints fit in the high bits the session codec reserves', () => {
    expect(ALL_HINTS).toBe(0x3f00)
    expect(ALL_HINTS & RUNG_MASK).toBe(0)
  })

  it('rides along in mintSession as hints without disturbing the rungs', () => {
    const s = mintSession({
      identityKey: '02'.padEnd(66, 'd'),
      amount: 1,
      derivationPrefix: 'cA',
      derivationSuffix: 'cw',
      supportsAwdl: true,
      hints: capsFromProbe(allSet),
    })
    expect(s.caps & RUNG_MASK).toBe(CAP_AWDL)
    expect(s.caps & ~RUNG_MASK).toBe(ALL_HINTS)
  })
})

describe('readBluetoothState', () => {
  afterEach(() => jest.clearAllMocks())

  it('returns the native state verbatim when it is one of the five known strings', () => {
    getLocalPayBleTransport.mockReturnValue({ bluetoothState: () => 'poweredOff', nfcAvailable: () => false })
    expect(readBluetoothState()).toBe('poweredOff')
  })

  it('reads a device with no BLE HybridObject as unsupported', () => {
    getLocalPayBleTransport.mockReturnValue(null)
    expect(readBluetoothState()).toBe('unsupported')
  })

  it('coerces an unrecognised native string to unknown', () => {
    getLocalPayBleTransport.mockReturnValue({ bluetoothState: () => 'resetting', nfcAvailable: () => false })
    expect(readBluetoothState()).toBe('unknown')
  })

  it('never throws: a native throw reads as unknown', () => {
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => {
        throw new Error('bridge gone')
      },
      nfcAvailable: () => false,
    })
    expect(readBluetoothState()).toBe('unknown')
  })
})

describe('probeDeviceCaps', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    jest.clearAllMocks()
  })

  it('exposes the budgets NearbyFlow mints against', () => {
    expect(DEFAULT_NET_BUDGET_MS).toBe(800)
    expect(BLE_PREPARE_TIMEOUT_MS).toBe(1500)
  })

  it('reads wifi from the radio flag on android', async () => {
    Platform.OS = 'android'
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toEqual({
      online: true,
      connected: true,
      wifi: true,
      bluetooth: 'unsupported',
      nfc: false,
    })
  })

  it('reads wifi from the association type on ios, so cellular is not wifi', async () => {
    Platform.OS = 'ios'
    netFetch.mockResolvedValue({ ...wifiState, type: 'cellular' })
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.wifi).toBe(false)
    expect(probe.online).toBe(true)
    expect(probe.connected).toBe(true)
  })

  it('ignores the android radio flag on ios', async () => {
    Platform.OS = 'ios'
    netFetch.mockResolvedValue({ ...wifiState, type: 'wifi', isWifiEnabled: false })
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toMatchObject({ wifi: true })
  })

  it('reports online and connected as unknown when NetInfo does not answer in budget', async () => {
    Platform.OS = 'android'
    netFetch.mockReturnValue(new Promise(() => {}))
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps({ netBudgetMs: 20 })
    expect(probe.online).toBeNull()
    expect(probe.connected).toBeNull()
    expect(probe.wifi).toBe(false)
    // Unknown must reach the wire as "not known", never as "online".
    expect(capsFromProbe(probe) & (HINT_ONLINE | HINT_ONLINE_KNOWN)).toBe(0)
  })

  it('reports unknown, not offline, when NetInfo rejects', async () => {
    netFetch.mockRejectedValue(new Error('NetInfo native module unavailable'))
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.online).toBeNull()
    expect(probe.connected).toBeNull()
    expect(probe.wifi).toBe(false)
  })

  it('keeps a null isInternetReachable as unknown even though the probe answered', async () => {
    netFetch.mockResolvedValue({ ...wifiState, isInternetReachable: null })
    getLocalPayBleTransport.mockReturnValue(null)

    const probe = await probeDeviceCaps()
    expect(probe.online).toBeNull()
    expect(probe.connected).toBe(true)
  })

  it('treats a missing BLE hybrid object as unsupported with no NFC', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue(null)

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unsupported', nfc: false })
  })

  it('passes a well-formed bluetoothState through and reads nfcAvailable', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => 'poweredOn',
      nfcAvailable: () => true,
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'poweredOn', nfc: true })
  })

  it('coerces a bluetoothState string it does not recognise to unknown', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => 'resetting',
      nfcAvailable: () => false,
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unknown', nfc: false })
  })

  it('survives a native method that throws', async () => {
    netFetch.mockResolvedValue(wifiState)
    getLocalPayBleTransport.mockReturnValue({
      bluetoothState: () => {
        throw new Error('CBManager not ready')
      },
      nfcAvailable: () => {
        throw new Error('NFCNDEFReaderSession unavailable')
      },
    })

    await expect(probeDeviceCaps()).resolves.toMatchObject({ bluetooth: 'unknown', nfc: false })
  })
})
