/**
 * NearbyFlow — the token path.
 *
 * A focused render test over the four facts ux design §4.3 makes about a
 * nearby token payment: the payer's confirm screen states the figure in the
 * asset's own units (never satoshis), the payee's own waiting screen never
 * shows a figure for an open request, a radio-acked send reads the drain's
 * own settlement state back as "settling" vs "settled", and a frame that
 * carries no attested evidence for the asset (`not_covered`) is refused with
 * the issuer-attributed sentence rather than read as a scanning mistake.
 *
 * The mock surface mirrors the existing NearbyFlow-adjacent suites
 * (payScreen.test.tsx, tokenPay.test.tsx, __tests__/localpay/deviceCaps.test.ts):
 * every native/radio boundary NearbyFlow itself only reaches through the
 * `@bsv/expo-wallet-toolbox` barrel is stubbed to force the QR-only, no-probe
 * path (`selectTransport` picks per test), and the local money-write module
 * NearbyFlow imports directly (`core/localpay/build`) is stubbed.
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
  useFocusEffect: () => {},
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
    // `useOnline` subscribes as well as probing; this mock never emits, so the
    // hook's own optimistic default stands until a test sets `fetch`.
    addEventListener: jest.fn(() => jest.fn())
  }
}))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: jest.fn(() => null),
  resolveIdentity: jest.fn(async () => [null, null]),
  identityLabel: jest.fn(() => undefined)
}))

// The BSV spendable line under the amount field sources its own figure; on
// the token path the field is handed the token figure as text instead, and
// this stub keeps the BSV read from ever touching the dummy wallet below.
jest.mock('../../ui/hooks/useSpendableBalance', () => ({ useSpendableBalance: () => 50_000 }))

// The scanner is a Modal-hosted camera view under the hood; the mock is a
// plain component that stashes its `onScan` so a test can drive it directly,
// exactly the seam a payee's real hand-over pipeline drives it from.
let mockScanHandler: ((data: string) => void) | undefined
jest.mock('../../ui/components/QRScanner', () => ({
  __esModule: true,
  default: (props: { onScan?: (data: string) => void }) => {
    mockScanHandler = props.onScan
    return null
  }
}))

const mockFinalizeDelivery = jest.fn()
jest.mock('../../core/localpay/build', () => ({
  ...jest.requireActual('../../core/localpay/build'),
  finalizeDelivery: (...args: unknown[]) => mockFinalizeDelivery(...args)
}))

const mockBuildPaymentFrame = jest.fn()
const mockVerifyFramePayment = jest.fn()
const mockProcessPending = jest.fn()
const mockMintSession = jest.fn()
const mockClaimAndSavePending = jest.fn()
// Realistic enough to prove the wiring: the real `holdSentPaymentOffline` /
// `parkSentPaymentOffline` (core/offline/payerHold.ts) call `onHandedOver`
// with the txid and the state the call represents — 'parked' for a park,
// 'handed_over' for a hold/release. NearbyFlow's own job is to pass the hook
// through; this mock exercises exactly that hand-off without pulling in the
// storage layer the real functions also touch.
const mockHoldSentPaymentOffline = jest.fn(
  async (args: { txid: string; onHandedOver?: (...a: unknown[]) => Promise<void> }) => {
    await args.onHandedOver?.(args.txid, 'handed_over')
  }
)
const mockParkSentPaymentOffline = jest.fn(
  async (args: { txid: string; onHandedOver?: (...a: unknown[]) => Promise<void> }) => {
    await args.onHandedOver?.(args.txid, 'parked')
  }
)
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const actual = jest.requireActual('@bsv/expo-wallet-toolbox')
  return {
    ...actual,
    useWalletManagers: () => ({
      managers: { permissionsManager: mockWallet() },
      adminOriginator: 'admin.test',
      storage: { sqliteDb: {}, getServices: () => ({ getChainTracker: async () => ({}) }) }
    }),
    // Forces the QR-only, no-probe rung: no radio ever spins up, so nothing
    // here needs a real Bluetooth/Wi-Fi/Nearby native module underneath it.
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
    selectTransport: jest.fn(() => 'qr'),
    awdlTransport: { kind: 'awdl', send: jest.fn(async () => ({ ok: true })) },
    bleTransport: { kind: 'ble', send: jest.fn(async () => ({ ok: true })) },
    nearbyTransport: { kind: 'nearby', send: jest.fn(async () => ({ ok: true })) },
    buildPaymentFrame: (...args: unknown[]) => mockBuildPaymentFrame(...args),
    sealFrame: jest.fn(() => new Uint8Array(4)),
    sealedToQr: jest.fn(() => 'bsvpayf1:stub'),
    frameBytesFromQr: jest.fn(() => new Uint8Array(4)),
    isAirGapPart: jest.fn(() => true),
    AirGapDecoder: jest.fn().mockImplementation(() => ({
      accept: jest.fn(() => ({ ok: true, have: 1, total: 1, done: true })),
      message: jest.fn(() => new Uint8Array(4))
    })),
    // The decode step below this (unsealFrame) is stubbed too: `message()`
    // above is not real sealed bytes, so the real decrypt/MAC-check would
    // throw before `verifyFramePayment` — the mock this suite actually
    // controls — ever ran.
    unsealFrame: jest.fn(() => ({ kind: 'token', transaction: new Uint8Array(0), outputIndex: 0 })),
    verifyFramePayment: (...args: unknown[]) => mockVerifyFramePayment(...args),
    processPending: (...args: unknown[]) => mockProcessPending(...args),
    // The real mint, observed: the payee test reads the nonces it minted.
    mintSession: (...args: unknown[]) => mockMintSession(...args),
    claimAndSavePending: (...args: unknown[]) => mockClaimAndSavePending(...args),
    holdSentPaymentOffline: (...args: unknown[]) => mockHoldSentPaymentOffline(...(args as [never])),
    parkSentPaymentOffline: (...args: unknown[]) => mockParkSentPaymentOffline(...(args as [never]))
  }
})
// A dummy wallet good enough for `startRequest`'s mint (getPublicKey,
// createNonce's own createHmac) and nothing more — no real signing ever runs
// in this test, because `buildPaymentFrame`/`finalizeDelivery` are stubbed.
function mockWallet() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: PAYEE_IDENTITY })),
    createHmac: jest.fn(async () => ({ hmac: new Array(32).fill(7) }))
  }
}

import React from 'react'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { FrameVerifyError, ThemeProvider, mintSession, type Session, type SessionAsset } from '@bsv/expo-wallet-toolbox'
import NearbyFlow from '../../ui/components/pay/NearbyFlow'
import { MandalaProvider } from '../../ui/hooks/useMandala'
import { makeFakeMandala, balanceOf, USDX } from '../__mocks__/fakeMandalaRuntime'

const PAYEE_IDENTITY = '03'.padEnd(66, 'e')

const ASSET: SessionAsset = {
  id: USDX.assetId,
  label: USDX.label,
  ticker: USDX.ticker,
  decimals: USDX.decimals
}

const wrap = (ui: React.ReactElement, runtime: ReturnType<typeof makeFakeMandala> | null = makeFakeMandala()) =>
  render(
    <ThemeProvider>
      <MandalaProvider runtime={runtime}>{ui}</MandalaProvider>
    </ThemeProvider>
  )

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
    satoshis: 1,
    tokenAmount: 2500n
  })
  mockFinalizeDelivery.mockResolvedValue({ kind: 'sent', broadcast: 'ok' })
  mockProcessPending.mockResolvedValue([])
  mockMintSession.mockImplementation(
    (jest.requireActual('@bsv/expo-wallet-toolbox') as { mintSession: (...a: unknown[]) => unknown }).mintSession
  )
  mockClaimAndSavePending.mockResolvedValue({ claimed: false })
  mockVerifyFramePayment.mockRejectedValue(new FrameVerifyError('unparseable', 'not used in this suite'))
  const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { selectTransport: jest.Mock }
  barrel.selectTransport.mockReturnValue('qr')
})

describe('NearbyFlow — the token path', () => {
  it('payer confirm screen states the token figure, never satoshis', async () => {
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const s = wrap(
      <NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    expect(s.getByText('25.00 USDX')).toBeTruthy()
    // Not the satoshi renderer under any format this session's 1 (BRC-92)
    // satoshi would otherwise print as.
    expect(s.queryByText(/sats|satoshi/i)).toBeNull()
  })

  it('payee QR carries no figure for an open token request', async () => {
    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ asset: ASSET }} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await waitFor(() => expect(s.getByText('local_pay_any_amount')).toBeTruthy())
    expect(s.queryByText(/^0\.00 USDX$/)).toBeNull()
    expect(s.queryByText(/USDX/)).toBeNull()
  })

  it('a radio-acked send reads back "settling" until its own settle reports settled', async () => {
    const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { selectTransport: jest.Mock }
    barrel.selectTransport.mockReturnValue('awdl')

    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const s = wrap(
      <NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })
    await waitFor(() => expect(s.getByText('token_sent_settling_unnamed:Acme Bank')).toBeTruthy())
  })

  it('takes the payer’s own submit AFTER the hold, and flips the receipt to settled', async () => {
    const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { selectTransport: jest.Mock }
    barrel.selectTransport.mockReturnValue('awdl')
    // "Settling" is the sentence this payer starts with — and the only thing
    // that may change it is their own settle (W5: the positive ack is the ACK).
    const netinfo = jest.requireMock('@react-native-community/netinfo') as { default: { fetch: jest.Mock } }
    netinfo.default.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'wifi' })
    // Just enough of the real `finalizeDelivery` to reach the hold, which is
    // what the ordering assertion below is about.
    mockFinalizeDelivery.mockImplementation(
      async (
        _wallet: unknown,
        built: { txid?: string },
        ack: { ok: boolean },
        _originator: unknown,
        deps: { hold: (txid: string) => Promise<void> }
      ) => {
        if (ack.ok && built.txid) await deps.hold(built.txid)
        return { kind: 'sent', broadcast: 'ok' }
      }
    )

    const runtime = makeFakeMandala({ balances: [balanceOf()], settleNow: 'settled' })
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const s = wrap(<NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />, runtime)
    await settle()
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })

    // The whole of the order, on this rail: ack → hold → submit. Nothing asks
    // the overlay anything until the payee provably has the frame and this
    // device has the queue row that owns it.
    await waitFor(() => expect(runtime.settleNow).toHaveBeenCalledWith('d'.repeat(64)))
    expect(mockHoldSentPaymentOffline).toHaveBeenCalled()
    expect(mockHoldSentPaymentOffline.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.settleNow.mock.invocationCallOrder[0]
    )
    // …and the receipt corrects itself once the row comes back admitted.
    await waitFor(() => expect(s.getByText('token_sent_settled:Acme Bank')).toBeTruthy())
  })

  it("a not_covered refusal at hand-over reads as the issuer's own refusal, not a scanning mistake", async () => {
    mockVerifyFramePayment.mockRejectedValue(new FrameVerifyError('not_covered', 'evidence does not cover this frame'))

    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ asset: ASSET }} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await waitFor(() => expect(s.getByText('local_pay_any_amount')).toBeTruthy())

    // Payee opens the scanner for the payer's frame — the Modal mounts the
    // mocked QRScanner, which stashes its onScan handler for this test to
    // drive directly, the same as the real camera driving it frame-by-frame.
    await act(async () => {
      fireEvent.press(s.getByText('local_pay_scan_payer_qr'))
    })
    await waitFor(() => expect(mockScanHandler).toBeTruthy())
    await act(async () => {
      mockScanHandler!('bsvpayf1:stub-part')
      await new Promise(resolve => setImmediate(resolve))
    })

    await waitFor(() => expect(s.getByText('token_cover_failed:Acme Bank')).toBeTruthy())
    // Live and unspent, not a terminal failure screen: the genuine payer can
    // still complete against the same pairing QR.
    expect(s.getByText('local_pay_any_amount')).toBeTruthy()
  })

  it('threads nearby.onHandedOver through both the park and the hold call sites', async () => {
    // A token session only — the BSV rail passes no `onHandedOver` at all, so
    // this is the one axis worth pinning.
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const runtime = makeFakeMandala({ balances: [balanceOf()] })

    // ── Back out of the code screen: parks, and journals 'parked' ──
    const parked = wrap(<NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />, runtime)
    await settle()
    await act(async () => {
      fireEvent.press(parked.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    await act(async () => {
      fireEvent.press(parked.getByLabelText('back'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockParkSentPaymentOffline).toHaveBeenCalledWith(
      expect.objectContaining({ txid: 'd'.repeat(64), onHandedOver: runtime.nearby.onHandedOver })
    )

    // ── A second payment, confirmed with Done: holds, and advances the row ──
    //
    // `finalizeDelivery` is otherwise a bare stub in this suite (it is not the
    // thing under test elsewhere), so it is given just enough of the real
    // function's own behaviour — calling the `hold` dependency on a positive
    // ack (`core/localpay/build.ts`'s `finalizeDelivery`) — to reach
    // `holdSentPaymentOffline`'s call site inside it.
    mockFinalizeDelivery.mockImplementation(
      async (
        _wallet: unknown,
        built: { txid?: string },
        ack: { ok: boolean },
        _originator: unknown,
        deps: { hold: (txid: string) => Promise<void> }
      ) => {
        if (ack.ok && built.txid) await deps.hold(built.txid)
        return { kind: 'sent', broadcast: 'ok' }
      }
    )
    const session2: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const confirmed = wrap(<NearbyFlow role="payer" initialSession={session2} onExit={jest.fn()} />, runtime)
    await settle()
    await act(async () => {
      fireEvent.press(confirmed.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    await act(async () => {
      fireEvent.press(confirmed.getByLabelText('done'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockHoldSentPaymentOffline).toHaveBeenCalledWith(
      expect.objectContaining({ txid: 'd'.repeat(64), onHandedOver: runtime.nearby.onHandedOver })
    )

    // Both call sites threaded the SAME hook through to the fake runtime,
    // recorded in the order the payer actually acted: parked first, then
    // (on the second payment) handed over.
    expect(runtime.nearby.onHandedOver).toHaveBeenNthCalledWith(1, 'd'.repeat(64), 'parked')
    expect(runtime.nearby.onHandedOver).toHaveBeenNthCalledWith(2, 'd'.repeat(64), 'handed_over')
  })
  // ── An OPEN token request: the payee named the asset but left the figure to the payer ──

  const openTokenSession = (): Session =>
    mintSession({
      identityKey: PAYEE_IDENTITY,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })

  it('an open token request takes the payer’s figure in the asset’s own units, never satoshis', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    // The field is in USDX: a two-decimal placeholder, the ticker as its unit
    // label, and the payer's own USDX holding under it — nothing satoshi-shaped.
    expect(s.getByPlaceholderText('0.00')).toBeTruthy()
    expect(s.getByText('USDX')).toBeTruthy()
    expect(s.queryByText(/sats|satoshi/i)).toBeNull()
    expect(s.getByText('1,240.00')).toBeTruthy()

    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25.00')
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    // 25.00 USDX is 2,500 base units on the wire — not the 25 a satoshi field
    // would have read off the same keystrokes.
    expect(mockBuildPaymentFrame).toHaveBeenCalledTimes(1)
    expect(mockBuildPaymentFrame.mock.calls[0][3]).toBe(2500n)
  })

  it('carries the payer’s typed note through to buildPaymentFrame', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    expect(s.getByText('note')).toBeTruthy()
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25.00')
    fireEvent.changeText(s.getByPlaceholderText('note_placeholder'), 'thanks!')
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockBuildPaymentFrame).toHaveBeenCalledTimes(1)
    expect(mockBuildPaymentFrame.mock.calls[0][5]).toBe('thanks!')
  })

  it('sends no note when the payer leaves the field blank', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25.00')
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockBuildPaymentFrame.mock.calls[0][5]).toBeFalsy()
  })

  it('Max on an open token request writes the payer’s real holding, not the satoshi send-max sentinel', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf(USDX, 124000n)] })
    )
    await settle()
    fireEvent.press(s.getByText('send_max'))
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    expect(mockBuildPaymentFrame).toHaveBeenCalledTimes(1)
    expect(mockBuildPaymentFrame.mock.calls[0][3]).toBe(124000n)
  })
  it('a QR hand-over confirmed with Done writes the token receipt, then this payer’s own submit — never "1 satoshi"', async () => {
    // The fountain rail: no ack payload, no σ_I to read back — the receipt is
    // the figure in USDX and "settling", and the immediate submit runs only
    // once the hold has the row.
    const netinfo = jest.requireMock('@react-native-community/netinfo') as { default: { fetch: jest.Mock } }
    netinfo.default.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'wifi' })
    mockFinalizeDelivery.mockImplementation(
      async (
        _wallet: unknown,
        built: { txid?: string },
        ack: { ok: boolean },
        _originator: unknown,
        deps: { hold: (txid: string) => Promise<void> }
      ) => {
        if (ack.ok && built.txid) await deps.hold(built.txid)
        return { kind: 'sent', broadcast: 'ok' }
      }
    )
    const runtime = makeFakeMandala({ balances: [balanceOf()], settleNow: 'settled' })
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: ASSET,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const s = wrap(<NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />, runtime)
    await settle()
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    await act(async () => {
      fireEvent.press(s.getByLabelText('done'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })

    // The receipt: the token figure and its settlement sentence, and not the
    // 1 satoshi the token output itself carries.
    expect(s.getByText('25.00 USDX')).toBeTruthy()
    expect(s.queryByText(/sats|satoshi/i)).toBeNull()
    await waitFor(() => expect(s.getByText('token_sent_settled:Acme Bank')).toBeTruthy())
    // ack (Done) → hold → submit, in that order, same as the radio rail.
    expect(mockHoldSentPaymentOffline).toHaveBeenCalled()
    expect(runtime.settleNow).toHaveBeenCalledWith('d'.repeat(64))
    expect(mockHoldSentPaymentOffline.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.settleNow.mock.invocationCallOrder[0]
    )
  })
  it('refuses more than the payer holds of the asset, in the asset’s own words, before any build', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf(USDX, 124000n)] })
    )
    await settle()
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '5000.00')
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(true)
    expect(s.getByText('pay_asset_over_balance:USDX')).toBeTruthy()
    // Back within the holding: the refusal goes, the button comes back.
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '1240.00')
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(false)
    expect(s.queryByText('pay_asset_over_balance:USDX')).toBeNull()
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })
  // ── Which side names the unit ──

  it("XR-091: a real local holding the wallet could not identify never trusts the payee's own unit claim", async () => {
    // A REAL holding exists (124000 base units, genuinely spendable) but this
    // device's own registry lookup for its ticker/decimals failed — the
    // runtime's `''`/`0` sentinel. The payee's QR names USDX/2, but that is
    // unauthenticated: trusting it would let a malicious or stale payee
    // dictate the scale a genuine transfer of the payer's own value is shown
    // and typed at (XR-091). This must fail closed exactly like the "neither
    // side can name it" case — never adopt the QR's ticker/decimals for a
    // real, unresolved holding.
    const unidentified = { ...USDX, ticker: '', label: '', decimals: 0 }
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf(unidentified, 124000n)] })
    )
    await settle()
    expect(s.queryByText('USDX')).toBeNull()
    expect(s.getByText('pay_asset_unidentified')).toBeTruthy()
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(true)
    fireEvent.changeText(s.getByPlaceholderText('0'), '25')
    await act(async () => {
      fireEvent.press(s.getByLabelText('local_pay_send'))
      await new Promise(resolve => setImmediate(resolve))
    })
    // Never builds a payment scaled by the payee's unverified decimals against
    // this real holding.
    expect(mockBuildPaymentFrame).not.toHaveBeenCalled()
  })

  it('the wallet’s own resolved decimals win over what the payee’s QR claims', async () => {
    // A request claiming 4 decimals for an asset this wallet knows has 2:
    // 2,500 base units is 25.00 USDX, and that is what the confirm shows.
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: { ...ASSET, decimals: 4 },
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const s = wrap(
      <NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf()] })
    )
    await settle()
    expect(s.getByText('25.00 USDX')).toBeTruthy()
    expect(s.queryByText('0.2500 USDX')).toBeNull()
  })

  it('refuses to send when neither side can name the unit, rather than offering an unlabelled field', async () => {
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      asset: { id: ASSET.id },
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const unidentified = { ...USDX, ticker: '', label: '', decimals: 0 }
    const s = wrap(
      <NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf(unidentified, 124000n)] })
    )
    await settle()
    expect(s.getByText('pay_asset_unidentified')).toBeTruthy()
    fireEvent.changeText(s.getByPlaceholderText('0'), '25')
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(true)
  })

  it('shows no balance line at all for a token this wallet does not hold', async () => {
    const s = wrap(
      <NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [] })
    )
    await settle()
    expect(s.getByText('USDX')).toBeTruthy()
    expect(s.queryByText(/available/)).toBeNull()
  })
  it('clears a typed figure when the resolved unit moves underneath it', async () => {
    // The session says USDX/2; the payer types 25.00 before this wallet's own
    // holding has resolved. The holding then lands at 4 decimals and wins —
    // the field must not keep "25.00" while emitting 2,500 base units of a
    // 4-decimal unit (0.2500 USDX).
    const runtime = makeFakeMandala({ balances: [] })
    const s = wrap(<NearbyFlow role="payer" initialSession={openTokenSession()} onExit={jest.fn()} />, runtime)
    await settle()
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25.00')
    expect(s.getByPlaceholderText('0.00').props.value).toBe('25.00')
    runtime.balances.mockResolvedValue([balanceOf({ ...USDX, decimals: 4 }, 1240000n)])
    await act(async () => {
      runtime.emit()
      await new Promise(resolve => setImmediate(resolve))
    })
    await waitFor(() => expect(s.getByPlaceholderText('0.0000')).toBeTruthy())
    expect(s.getByPlaceholderText('0.0000').props.value).toBe('')
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(true)
  })
  it('a payee-named figure in a unit nobody can name is not printed as a bare number', async () => {
    const session: Session = mintSession({
      identityKey: PAYEE_IDENTITY,
      units: 2500n,
      asset: { id: ASSET.id },
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      supportsAwdl: false
    })
    const unidentified = { ...USDX, ticker: '', label: '', decimals: 0 }
    const s = wrap(
      <NearbyFlow role="payer" initialSession={session} onExit={jest.fn()} />,
      makeFakeMandala({ balances: [balanceOf(unidentified, 124000n)] })
    )
    await settle()
    expect(s.getByText('token_row_amount_pending')).toBeTruthy()
    expect(s.queryByText(/2,500/)).toBeNull()
    expect(s.getByText('pay_asset_unidentified')).toBeTruthy()
    expect(s.getByLabelText('local_pay_send').props.accessibilityState.disabled).toBe(true)
  })
})

describe('NearbyFlow — the token path, payee side (plan 07 Task 16)', () => {
  /** A real AtomicBEEF, so the screen can read the txid it asks the journal about. */
  function receiptBeef(): Uint8Array {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
  }

  /** Drives the payee's scanner with a frame bound to the session this payee minted. */
  async function receiveScannedFrame(s: ReturnType<typeof wrap>) {
    const hosted = mockMintSession.mock.results[mockMintSession.mock.results.length - 1].value as Session
    const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { unsealFrame: jest.Mock }
    barrel.unsealFrame.mockImplementation(() => ({
      version: 6,
      kind: 'token',
      senderIdentityKey: '02'.padEnd(66, 'c'),
      outputIndex: 0,
      derivationPrefix: hosted.derivationPrefix,
      derivationSuffix: hosted.derivationSuffix,
      token: { assetId: ASSET.id, certificates: [], profileData: '{}' },
      transaction: receiptBeef()
    }))
    await act(async () => {
      fireEvent.press(s.getByText('local_pay_scan_payer_qr'))
    })
    await waitFor(() => expect(mockScanHandler).toBeTruthy())
    await act(async () => {
      mockScanHandler!('bsvpayf1:stub-part')
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    })
    return hosted
  }

  function payeeRuntime(state: string | undefined) {
    const runtime = makeFakeMandala({ balances: [balanceOf()] })
    ;(runtime as { journal: unknown }).journal = {
      get: jest.fn(async () => (state === undefined ? undefined : { role: 'received', state }))
    }
    return runtime
  }

  it('mints a priced token request as exact units and shows the figure on its QR', async () => {
    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ sats: 2500, asset: ASSET }} onExit={jest.fn()} />,
      payeeRuntime(undefined)
    )
    await waitFor(() => expect(s.getByText('25.00 USDX')).toBeTruthy())
    const minted = mockMintSession.mock.calls[mockMintSession.mock.calls.length - 1][0] as Record<string, unknown>
    expect(minted.units).toBe(2500n)
    expect(minted).not.toHaveProperty('amount')
  })

  it('verifies against its own session asset, credits through nearby.onReceived, and says "not cleared" while held', async () => {
    const runtime = payeeRuntime('held')
    mockVerifyFramePayment.mockResolvedValue({ kind: 'token', assetId: ASSET.id, units: 2500n })
    mockClaimAndSavePending.mockResolvedValue({ claimed: true, entry: { id: 'e1' } })
    mockProcessPending.mockResolvedValue([{ id: 'e1', success: true }])
    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ sats: 2500, asset: ASSET }} onExit={jest.fn()} />,
      runtime
    )
    await waitFor(() => expect(s.getByText('25.00 USDX')).toBeTruthy())
    await receiveScannedFrame(s)

    await waitFor(() => expect(mockProcessPending).toHaveBeenCalledTimes(1))
    // The session's OWN asset is the binding, never the frame's.
    expect(mockVerifyFramePayment.mock.calls[0][3]).toEqual({ assetId: ASSET.id })
    // One hook, after the internalize: no pre-internalize write any more.
    const args = mockProcessPending.mock.calls[0] as unknown[]
    expect(args).toHaveLength(5)
    expect(args[4]).toBe(runtime.nearby.onReceived)
    await waitFor(() => expect(s.getByText('local_pay_token_not_cleared:Acme Bank')).toBeTruthy())
    expect(s.getByText('25.00 USDX')).toBeTruthy()
  })

  it('drops the "not cleared" copy only when the journal reads settled', async () => {
    mockVerifyFramePayment.mockResolvedValue({ kind: 'token', assetId: ASSET.id, units: 2500n })
    mockClaimAndSavePending.mockResolvedValue({ claimed: true, entry: { id: 'e1' } })
    mockProcessPending.mockResolvedValue([{ id: 'e1', success: true }])
    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ sats: 2500, asset: ASSET }} onExit={jest.fn()} />,
      payeeRuntime('settled')
    )
    await waitFor(() => expect(s.getByText('25.00 USDX')).toBeTruthy())
    await receiveScannedFrame(s)
    await waitFor(() => expect(mockProcessPending).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(s.queryByText('local_pay_token_not_cleared:Acme Bank')).toBeNull())
  })

  it('refuses a frame locking a different figure than the request named, before any write', async () => {
    mockVerifyFramePayment.mockResolvedValue({ kind: 'token', assetId: ASSET.id, units: 2499n })
    const s = wrap(
      <NearbyFlow role="payee" initialRequest={{ sats: 2500, asset: ASSET }} onExit={jest.fn()} />,
      payeeRuntime(undefined)
    )
    await waitFor(() => expect(s.getByText('25.00 USDX')).toBeTruthy())
    await receiveScannedFrame(s)
    await waitFor(() => expect(mockVerifyFramePayment).toHaveBeenCalledTimes(1))
    expect(mockClaimAndSavePending).not.toHaveBeenCalled()
    expect(mockProcessPending).not.toHaveBeenCalled()
    // Still live: the genuine payer can complete against the same request.
    expect(s.getByText('25.00 USDX')).toBeTruthy()
  })
})
