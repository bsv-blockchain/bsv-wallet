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
/** The chain the mounted storage records; the payer compares networks only when it is the picker's ('main' by default). */
let mockStorageChain: string | undefined
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
const mockBleSend = jest.fn()
const mockFallbackRadio = jest.fn((..._args: unknown[]): string | null => null)

/** The network the payer's wallet reports; only a merchant request asks for it. */
let mockWalletNetwork = 'mainnet'
function mockWallet() {
  return {
    getNetwork: jest.fn(async () => ({ network: mockWalletNetwork })),
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
      storage: { sqliteDb: {}, chain: mockStorageChain }
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
    bleTransport: { kind: 'ble', send: (...args: unknown[]) => mockBleSend(...args) },
    fallbackRadio: (...args: unknown[]) => mockFallbackRadio(...args),
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
import PaymentQrDisplay from '../../ui/components/pay/PaymentQrDisplay'
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
  mockFallbackRadio.mockReturnValue(null)
  mockBleSend.mockResolvedValue({ ok: true })
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

// Graceful degradation AWDL → BLE → QR. The second radio is only ever tried
// when the first provably never connected; a failure after the link came up
// may already have delivered the frame, so it must go to the fountain.
describe('AWDL → BLE → QR fallback', () => {
  const pressSend = async (s: ReturnType<typeof wrap>) => {
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    })
  }

  it('delivers over BLE when AWDL never connected', async () => {
    mockAwdlSend.mockRejectedValue(new Error('connect timeout: no route to peer'))
    mockFallbackRadio.mockReturnValue('ble')

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()
    await pressSend(s)

    expect(mockBleSend).toHaveBeenCalledTimes(1)
    expect(mockFinalizeDelivery).toHaveBeenCalledTimes(1)
    expect(s.queryByText('local_pay_radio_fallback')).toBeNull()
  })

  it('falls to QR when BLE also fails', async () => {
    mockAwdlSend.mockRejectedValue(new Error('no route to peer: connection cancelled'))
    mockFallbackRadio.mockReturnValue('ble')
    mockBleSend.mockRejectedValue(new Error('connect timeout: no route to peer'))

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()
    await pressSend(s)

    expect(mockBleSend).toHaveBeenCalledTimes(1)
    expect(mockFinalizeDelivery).not.toHaveBeenCalled()
    expect(s.getByText('local_pay_radio_fallback')).toBeTruthy()
  })

  it('never tries BLE after AWDL connected and then lost the ack — straight to QR', async () => {
    mockAwdlSend.mockRejectedValue(new Error('timed out waiting for peer'))
    mockFallbackRadio.mockReturnValue('ble')

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()
    await pressSend(s)

    expect(mockBleSend).not.toHaveBeenCalled()
    expect(mockFinalizeDelivery).not.toHaveBeenCalled()
    expect(s.getByText('local_pay_radio_fallback')).toBeTruthy()
  })

  it('goes to QR when there is no fallback radio', async () => {
    mockAwdlSend.mockRejectedValue(new Error('connect timeout: no route to peer'))

    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()
    await pressSend(s)

    expect(mockBleSend).not.toHaveBeenCalled()
    expect(s.getByText('local_pay_radio_fallback')).toBeTruthy()
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

// A host drawing the payer's steps itself (Bitcoin SV Wallet): its confirm
// replaces the built-in one, and the actions it is handed run the same send.
describe('renderPayer', () => {
  it('hands the confirm to the host and sends through the shared path', async () => {
    mockAwdlSend.mockResolvedValue({ ok: true })
    let confirm: import('../../ui/components/pay/NearbyFlow').NearbyConfirm | undefined
    const s = wrap(
      <NearbyFlow
        role="payer"
        initialSession={session()}
        onExit={jest.fn()}
        renderPayer={{
          confirm: c => {
            confirm = c
            return null
          }
        }}
      />
    )
    await settle()
    expect(confirm?.fixedAmount).toBe(2500)
    expect(confirm?.canSend).toBe(true)
    expect(s.queryByLabelText('local_pay_send')).toBeNull()
    await act(async () => {
      confirm!.send()
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockAwdlSend).toHaveBeenCalledTimes(1)
    expect(mockFinalizeDelivery).toHaveBeenCalledTimes(1)
  })
})

// Two phones on different networks: without the check the payment fails with
// nothing on either screen to say why.
describe('payer network check', () => {
  const sessionOn = (network?: string): Session =>
    mintSession({
      identityKey: PAYEE_IDENTITY,
      amount: 2500,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false,
      ...(network === undefined ? {} : { network })
    })
  const mountPayer = (initialSession: Session) => {
    const confirm = jest.fn(() => null)
    const s = wrap(
      <NearbyFlow role="payer" initialSession={initialSession} onExit={jest.fn()} renderPayer={{ confirm }} />
    )
    return { s, confirm }
  }
  afterEach(() => {
    mockStorageChain = undefined
  })

  it('stops a code from another network before the confirm, and names both networks', async () => {
    mockStorageChain = 'main'
    const { s, confirm } = mountPayer(sessionOn('test'))
    await settle()
    expect(s.getByText('local_pay_wrong_network:testnet|mainnet')).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })

  it('lets a code from the same network through to the confirm', async () => {
    mockStorageChain = 'main'
    const { s, confirm } = mountPayer(sessionOn('main'))
    await settle()
    expect(confirm).toHaveBeenCalled()
    expect(s.queryByText(/local_pay_wrong_network/)).toBeNull()
  })

  it('lets a code with no network (an older payee) through, as before', async () => {
    mockStorageChain = 'main'
    const { confirm } = mountPayer(sessionOn())
    await settle()
    expect(confirm).toHaveBeenCalled()
  })

  it('makes no comparison while storage is still the previous chain', async () => {
    mockStorageChain = 'test'
    const { confirm } = mountPayer(sessionOn('test'))
    await settle()
    expect(confirm).toHaveBeenCalled()
  })
})

// A host drawing the failure itself (Bitcoin SV Wallet). It is handed the
// cause as a code, set where the failure is created, and only the actions that
// cause allows. The built-in screen reads the same actions.
describe('renderFailed (payer)', () => {
  type Failed = import('../../ui/components/pay/NearbyFlow').NearbyFailed
  const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { selectTransport: jest.Mock }
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } }
  const { WERR_INSUFFICIENT_FUNDS } = jest.requireActual('@bsv/sdk') as typeof import('@bsv/sdk')
  const TOO_LARGE = 5_000_000

  const mount = (initialSession: Session = session()) => {
    const seen: Failed[] = []
    const s = wrap(
      <NearbyFlow
        role="payer"
        initialSession={initialSession}
        onExit={jest.fn()}
        renderFailed={f => {
          seen.push(f)
          return null
        }}
      />
    )
    return { s, last: () => seen[seen.length - 1] as Failed | undefined }
  }
  const pressSend = async (s: ReturnType<typeof wrap>) => {
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    })
  }
  const failWith = async (arrange: () => void) => {
    arrange()
    const { s, last } = mount()
    await settle()
    await pressSend(s)
    return { s, failed: last() }
  }

  afterEach(() => {
    mockFinalizeDelivery.mockResolvedValue({ kind: 'sent', broadcast: 'ok' })
    mockAwdlSend.mockReset()
    barrel.selectTransport.mockReturnValue('awdl')
    mockStorageChain = undefined
    mockWalletNetwork = 'mainnet'
  })

  it('replaces the built-in failure screen and offers the ordinary actions', async () => {
    const { s, failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(new Error('signer went away')))
    expect(failed).toMatchObject({ cause: 'unknown', detail: 'signer went away', role: 'payer', amount: 2500 })
    expect(failed?.recipientName).toBeTruthy()
    // No frame is in hand on this device: start again, or give up.
    expect(failed?.retry).toEqual(expect.any(Function))
    expect(failed?.cancel).toEqual(expect.any(Function))
    expect(failed?.retrySave).toBeUndefined()
    expect(failed?.openSettings).toBeUndefined()
    expect(failed?.checkWallet).toBeUndefined()
    expect(failed?.showCode).toBeUndefined()
    expect(failed?.declineReason).toBeUndefined()
    // The host's screen is the only one drawn.
    expect(s.queryByText('local_pay_failed')).toBeNull()
    expect(s.queryByText('retry')).toBeNull()
  })

  it('draws the built-in screen for the same failure when the host gives no renderFailed', async () => {
    mockBuildPaymentFrame.mockRejectedValue(new Error('signer went away'))
    const s = wrap(<NearbyFlow role="payer" initialSession={session()} onExit={jest.fn()} />)
    await settle()
    await pressSend(s)
    expect(s.getByText('local_pay_failed')).toBeTruthy()
    expect(s.getByText('signer went away')).toBeTruthy()
    expect(s.getByText('retry')).toBeTruthy()
    expect(s.queryByText('cancel')).toBeNull()
    expect(s.queryByText('local_pay_retry_save')).toBeNull()
    expect(s.queryByText('open_settings')).toBeNull()
    expect(s.queryByText('check_wallet')).toBeNull()
  })

  it('retry starts the payment again from the confirm step', async () => {
    const { s, failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(new Error('signer went away')))
    await act(async () => {
      failed!.retry!()
    })
    await settle()
    expect(s.getByLabelText('local_pay_send')).toBeTruthy()
  })

  it('names insufficient funds by the SDK error class, and keeps the sentence in detail', async () => {
    const error = new WERR_INSUFFICIENT_FUNDS(3000, 500)
    const { failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(error))
    expect(failed?.cause).toBe('insufficient-funds')
    expect(failed?.detail).toBe(error.message)
    expect(failed?.retry).toEqual(expect.any(Function))
  })

  it('names insufficient funds by the wallet error name, whatever the sentence says', async () => {
    // A toolbox error: `name` and `code` are the WERR_* string, and the
    // sentence has none of the words a text match would look for.
    const error = Object.assign(new Error('Guthaben reicht nicht'), {
      name: 'WERR_INSUFFICIENT_FUNDS',
      code: 'WERR_INSUFFICIENT_FUNDS'
    })
    const { failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(error))
    expect(failed).toMatchObject({ cause: 'insufficient-funds', detail: 'Guthaben reicht nicht' })
  })

  it('does not read insufficient funds off the sentence of an untyped error', async () => {
    const { failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(new Error('Insufficient funds')))
    expect(failed?.cause).toBe('unknown')
  })

  it('offers Check Wallet for a stuck payment, with cause unknown', async () => {
    const { failed } = await failWith(() => mockBuildPaymentFrame.mockRejectedValue(new Error('WERR_REVIEW_ACTIONS')))
    expect(failed).toMatchObject({ cause: 'unknown', detail: 'error_review_actions' })
    failed!.checkWallet!()
    expect(router.push).toHaveBeenCalledWith('/wallet-check')
  })

  it.each([
    ['session_mismatch', 'declined', 'local_pay_declined_mismatch'],
    ['already_paid', 'declined', 'local_pay_declined_already_paid'],
    ['save_failed', 'declined', 'local_pay_declined_save'],
    ['decode_failed', 'declined', 'local_pay_declined_decode'],
    ['not_covered', 'declined', 'local_pay_declined_not_covered'],
    ['root_unverified', 'unverified', 'local_pay_declined_root_unverified']
  ])('a %s decline has cause %s and carries the code', async (reason, cause, detail) => {
    const { failed } = await failWith(() => {
      mockAwdlSend.mockResolvedValue({ ok: false, error: reason })
      mockFinalizeDelivery.mockResolvedValue({ kind: 'declined', reason })
    })
    expect(failed).toMatchObject({ cause, declineReason: reason, detail, role: 'payer' })
    // The payee refused it and the inputs are released: never offered as a code.
    expect(failed?.showCode).toBeUndefined()
    expect(failed?.retry).toEqual(expect.any(Function))
  })

  it('a decline code this build does not know is still a decline, echoed as the detail', async () => {
    const { failed } = await failWith(() => {
      mockAwdlSend.mockResolvedValue({ ok: false, error: 'quota_exceeded' })
      mockFinalizeDelivery.mockResolvedValue({ kind: 'declined', reason: 'quota_exceeded' })
    })
    expect(failed).toMatchObject({ cause: 'declined', declineReason: 'quota_exceeded', detail: 'quota_exceeded' })
  })

  it('a decline with no code is a decline with no declineReason', async () => {
    const { failed } = await failWith(() => {
      mockAwdlSend.mockResolvedValue({ ok: false })
      mockFinalizeDelivery.mockResolvedValue({ kind: 'declined' })
    })
    expect(failed).toMatchObject({ cause: 'declined', detail: 'local_pay_failed' })
    expect(failed?.declineReason).toBeUndefined()
  })

  it('a code too large to show has cause too-large (code path)', async () => {
    const { failed } = await failWith(() => {
      barrel.selectTransport.mockReturnValue('qr')
      mockSealFrame.mockReturnValue(new Uint8Array(TOO_LARGE))
    })
    expect(failed).toMatchObject({ cause: 'too-large', detail: 'local_pay_too_large' })
    expect(failed?.openSettings).toBeUndefined()
  })

  it('a failed radio with a code too large to show has cause too-large (radio path)', async () => {
    const { failed } = await failWith(() => {
      mockAwdlSend.mockRejectedValue(new Error('connect timeout'))
      mockSealFrame.mockReturnValue(new Uint8Array(TOO_LARGE))
    })
    expect(failed).toMatchObject({ cause: 'too-large', detail: 'local_pay_too_large' })
    expect(failed?.openSettings).toBeUndefined()
  })

  it('Local Network access off has cause network-permission and a way to Settings', async () => {
    const { failed } = await failWith(() => {
      mockAwdlSend.mockRejectedValue(new Error('Operation not permitted'))
      mockSealFrame.mockReturnValue(new Uint8Array(TOO_LARGE))
    })
    expect(failed).toMatchObject({ cause: 'network-permission', detail: 'local_pay_network_denied' })
    expect(failed?.openSettings).toEqual(expect.any(Function))
  })

  it('a code from another network has cause wrong-network', async () => {
    mockStorageChain = 'main'
    const { last } = mount(
      mintSession({
        identityKey: PAYEE_IDENTITY,
        amount: 2500,
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        supportsAwdl: false,
        network: 'test'
      })
    )
    await settle()
    expect(last()).toMatchObject({ cause: 'wrong-network', detail: 'local_pay_wrong_network:testnet|mainnet' })
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })

  // One sentence covers both merchant refusals; the code tells them apart.
  const MERCHANT_DETAIL = 'Merchant request expired or uses a different network.'
  const merchantSession = (expires: number): Session => ({
    ...session(),
    merchantChain: 'main',
    merchantExpires: expires
  })

  it('a merchant request for another network has cause wrong-network', async () => {
    mockWalletNetwork = 'testnet'
    const { s, last } = mount(merchantSession(Date.now() + 60_000))
    await settle()
    await pressSend(s)
    expect(last()).toMatchObject({ cause: 'wrong-network', detail: MERCHANT_DETAIL })
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })

  it('an expired merchant request on the right network has cause unknown', async () => {
    const { s, last } = mount(merchantSession(Date.now() - 1))
    await settle()
    await pressSend(s)
    expect(last()).toMatchObject({ cause: 'unknown', detail: MERCHANT_DETAIL })
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })

  it('a payment code that cannot be drawn has cause too-large', async () => {
    // The radio fails, so the payment is shown as a code; then the encoder
    // reports that it cannot draw it.
    mockAwdlSend.mockRejectedValue(new Error('connect timeout: no route to peer'))
    const { s, last } = mount()
    await settle()
    await pressSend(s)
    expect(last()).toBeUndefined()
    await act(async () => {
      s.UNSAFE_getByType(PaymentQrDisplay).props.onError()
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(last()).toMatchObject({ cause: 'too-large', detail: 'local_pay_too_large' })
    expect(last()?.showCode).toBeUndefined()
  })
})

// The host screens draw a face from the wallet identity. The key is the one
// the payment is addressed to, read from the scanned session.
describe('identity keys on the payer steps', () => {
  type Seen = {
    confirm?: import('../../ui/components/pay/NearbyFlow').NearbyConfirm
    sending?: import('../../ui/components/pay/NearbyFlow').NearbySending
    showCode?: import('../../ui/components/pay/NearbyFlow').NearbyShowCode
    done?: import('../../ui/components/pay/NearbyFlow').NearbyDone
  }
  const mount = () => {
    const seen: Seen = {}
    wrap(
      <NearbyFlow
        role="payer"
        initialSession={session()}
        onExit={jest.fn()}
        renderPayer={{
          confirm: c => ((seen.confirm = c), null),
          sending: v => ((seen.sending = v), null),
          showCode: v => ((seen.showCode = v), null),
          done: v => ((seen.done = v), null)
        }}
      />
    )
    return seen
  }
  const send = async (seen: Seen) => {
    await act(async () => {
      seen.confirm!.send()
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    })
  }
  afterEach(() => mockAwdlSend.mockReset())

  it('confirm, sending and done name the payee by identity key', async () => {
    let resolveSend!: (ack: unknown) => void
    mockAwdlSend.mockReturnValue(new Promise(resolve => (resolveSend = resolve)))
    const seen = mount()
    await settle()
    expect(seen.confirm?.recipient.identityKey).toBe(PAYEE_IDENTITY)

    await send(seen)
    expect(seen.sending?.recipient.identityKey).toBe(PAYEE_IDENTITY)

    await act(async () => {
      resolveSend({ ok: true })
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    })
    expect(seen.done?.recipientKey).toBe(PAYEE_IDENTITY)
  })

  it('the code step names the payee by identity key', async () => {
    mockAwdlSend.mockRejectedValue(new Error('connect timeout: no route to peer'))
    const seen = mount()
    await settle()
    await send(seen)
    expect(seen.showCode?.recipient.identityKey).toBe(PAYEE_IDENTITY)
  })
})
