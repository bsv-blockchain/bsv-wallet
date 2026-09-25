/**
 * NearbyFlow — XR-096, the payer's radio-send path.
 *
 * Two genuinely ambiguous outcomes used to leave a signed, noSend action with
 * no durable trace beyond the raw wallet transaction row: a screen
 * blur/unmount while a native radio.send() is still in flight, and a radio
 * failure with no representable QR fallback (the sealed frame is over the
 * air-gap size ceiling). Both must now park the payment (parkSentPaymentOffline)
 * instead of a bare return/fail(...).
 *
 * Unlike nearbyFlowToken.test.tsx, `useFocusEffect` here is the REAL hook
 * (via useEffect), so unmounting this component actually runs the cleanup
 * that wires to `abortAll()` — the only way to reproduce a mid-send abort.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join('|')}` : key),
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  // The real hook, so an unmount actually runs its cleanup — that cleanup is
  // wired to `abortAll()`, the only way this suite can reproduce a mid-send
  // abort without a real native radio module.
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
  useNavigation: () => ({ addListener: () => () => {} })
}))
jest.mock('react-native-qrcode-svg', () => 'QRCode')
jest.mock('@bsv/react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
  getLocalPayBleTransport: jest.fn()
}))
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({ isConnected: false, isInternetReachable: false, type: 'none' })),
    addEventListener: jest.fn(() => jest.fn())
  }
}))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: jest.fn(() => null),
  resolveIdentity: jest.fn(async () => [null, null]),
  identityLabel: jest.fn(() => undefined)
}))
jest.mock('../../ui/hooks/useSpendableBalance', () => ({ useSpendableBalance: () => 50_000 }))

let mockScanHandler: ((data: string) => void) | undefined
jest.mock('../../ui/components/QRScanner', () => ({
  __esModule: true,
  default: (props: { onScan?: (data: string) => void }) => {
    mockScanHandler = props.onScan
    return null
  }
}))

const mockFinalizeDelivery = jest.fn().mockResolvedValue({ kind: 'sent', broadcast: 'ok' })
jest.mock('../../core/localpay/build', () => ({
  ...jest.requireActual('../../core/localpay/build'),
  finalizeDelivery: (...args: unknown[]) => mockFinalizeDelivery(...args)
}))

const mockBuildPaymentFrame = jest.fn()
const mockParkSentPaymentOffline = jest.fn().mockResolvedValue(undefined)
const mockSealFrame = jest.fn(() => new Uint8Array(4))
const mockAwdlSend = jest.fn()

function mockWallet() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: PAYEE_IDENTITY })),
    createHmac: jest.fn(async () => ({ hmac: new Array(32).fill(7) }))
  }
}

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const actual = jest.requireActual('@bsv/expo-wallet-toolbox')
  return {
    ...actual,
    useWalletManagers: () => ({
      managers: { permissionsManager: mockWallet() },
      adminOriginator: 'admin.test',
      storage: { sqliteDb: {} }
    }),
    localSupportsAwdl: jest.fn(() => false),
    localSupportsBle: jest.fn(() => false),
    localSupportsNearby: jest.fn(() => false),
    probeDeviceCaps: jest.fn(async () => ({})),
    capsFromProbe: jest.fn(() => 0),
    prepareBle: jest.fn(async () => 'unsupported'),
    readBluetoothState: jest.fn(() => 'unknown'),
    requestNearbyPermissions: jest.fn(async () => false),
    requestBlePermissions: jest.fn(async () => false),
    raceReceivers: jest.fn(() => {}),
    describeFloor: jest.fn(() => 'none'),
    // Forces the radio (not QR) branch every test in this file exercises.
    selectTransport: jest.fn(() => 'awdl'),
    awdlTransport: { kind: 'awdl', send: (...args: unknown[]) => mockAwdlSend(...args) },
    bleTransport: { kind: 'ble', send: jest.fn(async () => ({ ok: true })) },
    nearbyTransport: { kind: 'nearby', send: jest.fn(async () => ({ ok: true })) },
    buildPaymentFrame: (...args: unknown[]) => mockBuildPaymentFrame(...args),
    sealFrame: () => mockSealFrame(),
    sealedToQr: jest.fn(() => 'bsvpayf1:stub'),
    frameBytesFromQr: jest.fn(() => new Uint8Array(4)),
    isAirGapPart: jest.fn(() => true),
    AirGapDecoder: jest.fn().mockImplementation(() => ({
      accept: jest.fn(() => ({ ok: true, have: 1, total: 1, done: true })),
      message: jest.fn(() => new Uint8Array(4))
    })),
    unsealFrame: jest.fn(() => ({ kind: 'bsv', transaction: new Uint8Array(0), outputIndex: 0 })),
    verifyFramePayment: jest.fn(),
    parkSentPaymentOffline: (...args: unknown[]) => mockParkSentPaymentOffline(...(args as [never]))
  }
})

import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { ThemeProvider, mintSession, type Session } from '@bsv/expo-wallet-toolbox'
import NearbyFlow from '../../ui/components/pay/NearbyFlow'
import { MandalaProvider } from '../../ui/hooks/useMandala'
import { makeFakeMandala } from '../__mocks__/fakeMandalaRuntime'

const PAYEE_IDENTITY = '03'.padEnd(66, 'e')

const wrap = (ui: React.ReactElement) =>
  render(
    <ThemeProvider>
      <MandalaProvider runtime={makeFakeMandala()}>{ui}</MandalaProvider>
    </ThemeProvider>
  )

const session = (): Session =>
  mintSession({
    identityKey: PAYEE_IDENTITY,
    amount: 2500,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    supportsAwdl: false
  })

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockScanHandler = undefined
  mockBuildPaymentFrame.mockResolvedValue({
    frame: {},
    reference: 'ref-1',
    txid: 'd'.repeat(64),
    satoshis: 2500
  })
  mockParkSentPaymentOffline.mockResolvedValue(undefined)
  mockSealFrame.mockReturnValue(new Uint8Array(4))
})

describe('XR-096: a screen blur/unmount mid-send parks the payment', () => {
  it('parks the built payment when the component unmounts while radio.send() is still in flight', async () => {
    let rejectSend!: (e: unknown) => void
    mockAwdlSend.mockImplementation(
      (_session: unknown, _frame: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          rejectSend = reject
          // Mirrors a real transport: it listens for the abort and rejects
          // once it fires, rather than resolving/rejecting on its own.
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()

    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })

    // The build has resolved and radio.send() is now in flight (pending).
    expect(mockBuildPaymentFrame).toHaveBeenCalled()
    expect(mockParkSentPaymentOffline).not.toHaveBeenCalled()

    // The blur/unmount: useFocusEffect's cleanup calls abortAll(), which
    // aborts the controller radio.send() was given.
    await act(async () => {
      s.unmount()
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })

    expect(mockParkSentPaymentOffline).toHaveBeenCalledWith(
      expect.objectContaining({ txid: 'd'.repeat(64), framePayload: 'bsvpayf1:stub' })
    )
    // Ambiguous, not a proven decline: finalizeDelivery (which would abort
    // and release the inputs) must never run for this outcome.
    expect(mockFinalizeDelivery).not.toHaveBeenCalled()
    // Quiet reference for cleanup, so no "reject called after test" warning.
    void rejectSend
  })
})

describe('XR-096: a radio failure with no representable QR fallback parks the payment', () => {
  it('parks the built payment when the sealed frame is too large to show as a QR', async () => {
    mockAwdlSend.mockRejectedValue(new Error('connect timeout'))
    // Bigger than the air-gap MAX_MESSAGE_BYTES ceiling, so the fallback
    // branch hits its own "no representable code" dead end.
    mockSealFrame.mockReturnValue(new Uint8Array(5_000_000))

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()

    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })

    expect(mockParkSentPaymentOffline).toHaveBeenCalledWith(
      expect.objectContaining({ txid: 'd'.repeat(64), framePayload: 'bsvpayf1:stub' })
    )
    expect(mockFinalizeDelivery).not.toHaveBeenCalled()
  })
})

// XR-097. Two `fireEvent.press` calls issued back to back, before either
// dispatch's async handler has reached its first await, mirror a genuine
// double-tap: both land while `phase` is still whatever it was before the
// first press, so a re-render-based disabled state cannot have caught up yet.
describe('XR-097: a double-tap cannot build two independent payments', () => {
  it('calls buildPaymentFrame exactly once when Send is pressed twice before the first build resolves', async () => {
    let resolveBuild!: (v: unknown) => void
    mockBuildPaymentFrame.mockReturnValue(
      new Promise(resolve => {
        resolveBuild = resolve
      })
    )
    mockAwdlSend.mockResolvedValue({ ok: true })

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()

    const button = s.getByLabelText('local_pay_send')
    await act(async () => {
      fireEvent.press(button)
      fireEvent.press(button)
    })

    expect(mockBuildPaymentFrame).toHaveBeenCalledTimes(1)

    // Let the one build resolve so nothing leaks a dangling promise into the
    // next test.
    await act(async () => {
      resolveBuild({ frame: {}, reference: 'ref-1', txid: 'd'.repeat(64), satoshis: 2500 })
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })
  })
})
