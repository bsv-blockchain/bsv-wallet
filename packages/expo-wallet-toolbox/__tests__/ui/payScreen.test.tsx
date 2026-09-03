/**
 * Render-level coverage for the Pay screen. The point is not the pixels: it is
 * that the grid renders both directions, that a cell opens, and that a deep
 * link preselects one — the three things a broken route would silently lose.
 *
 * Mocking follows the convention __tests__/PresenceRow.test.tsx and
 * __tests__/Toast.test.tsx establish: expo-haptics, @expo/vector-icons and
 * react-native-safe-area-context are stubbed (none of them survive
 * transformIgnorePatterns / the test renderer), while the REAL ThemeProvider
 * wraps the tree so the screen reads real tokens. On top of that, this screen
 * also reads i18n and the wallet, so react-i18next resolves `t` to the key
 * itself — which is what the assertions below match on — and WalletContext is
 * reduced to the two fields the screen consumes. The six cell components are
 * mocked to host-component names so the assertions can look for a cell by type
 * without dragging a camera, a MessageBox client or a QR renderer into a unit
 * test.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

// Pulled in as a side effect of requireActual-ing the barrel below: its
// LocalStorageProvider chain reaches these native modules at module top level.
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))

// The re-show modal renders <QRCode> directly (unlike the six cell components
// below, which are mocked wholesale) — react-native-qrcode-svg ships ESM and
// isn't in this repo's transformIgnorePatterns, so it needs the same
// bare-string stub the icons package gets above.
jest.mock('react-native-qrcode-svg', () => 'QRCode')

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))

// `t` returns the key, so every assertion below names the key it depends on.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  // Pulled in as a side effect of importing anything from the barrel: its
  // i18n/translations module calls i18n.use(initReactI18next) at module load.
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

// `storage` starts undefined: the queue effect below reads `storage?.sqliteDb`
// and returns early when it's absent, so most tests never touch the queue —
// only the ones that explicitly set mockStorage exercise it.
// Partial mock: app/pay.tsx pulls useWallet from the same package barrel as
// useTheme/spacing/validatePeerPayURI/isPayCell/etc — which this test needs
// REAL — so only useWallet is overridden, via requireActual for the rest.
let mockStorage: { sqliteDb: unknown } | undefined
const mockRunMonitorTask = jest.fn().mockResolvedValue('')
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    walletBuilding: false,
    walletBuilt: true,
    storage: mockStorage,
    txStatusVersion: 0,
    walletUserId: null,
    runMonitorTask: mockRunMonitorTask
  })
}))

// Without this, the real hook pulls in NetInfo, which has no native module
// under Jest and crashes the process with an unhandled rejection.
let mockOnline = true
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => mockOnline }))

const mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  // dismissTo is what leaving this screen uses — a bare navigate would re-push
  // the wallet above the cells being left behind rather than popping them off.
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true
  },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => {}
}))

jest.mock('../../ui/components/pay/NearbyFlow', () => 'NearbyFlow')
jest.mock('../../ui/components/pay/UniversalSend', () => 'UniversalSend')
jest.mock('../../ui/components/pay/RequestHub', () => ({
  __esModule: true,
  default: 'RequestHub',
  requestSatsFrom: (text: string) => {
    const n = Math.round(Number(text))
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
}))
jest.mock('../../ui/components/pay/HandleReceive', () => 'HandleReceive')
jest.mock('../../ui/components/pay/AddressReceive', () => 'AddressReceive')

import React from 'react'
import { render, act, waitFor } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PayScreen } from '../../ui/screens/PayScreen'
import { nearbyAdvisory } from '../../core/localpay/nearbyAdvisory'
import { ThemeProvider, resetProofNudgeForTests, mintSession, type OfflineActionRow } from '@bsv/expo-wallet-toolbox'

// Lowercase hex: validatePeerPayURI's compressed-key regex is case-sensitive,
// so an uppercase key is rejected as malformed.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const draw = () =>
  render(
    <ThemeProvider>
      <PayScreen />
    </ThemeProvider>
  )

// A minimal OfflineActionRow, letting each test override only what it checks.
const offlineRow = (overrides: Partial<OfflineActionRow>): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid: 'a'.repeat(64),
  seq: 1,
  role: 'received',
  senderIdentityKey: null,
  receivedVia: null,
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  framePayload: null,
  ...overrides
})

describe('PayScreen', () => {
  beforeEach(async () => {
    for (const k of Object.keys(mockParams)) delete mockParams[k]
    mockOnline = true
    mockStorage = undefined
    resetProofNudgeForTests()
    mockRunMonitorTask.mockClear()
    await AsyncStorage.clear()
  })

  it('titles the screen with the direction it was opened in, with no switcher', () => {
    // The direction is chosen before arriving (Pay vs Get paid on the wallet
    // screen), so the title carries it and the old segmented switcher is gone —
    // re-offering the choice would ask a question the user just answered.
    const { getByText, queryByText } = draw()
    expect(getByText('pay_direction_pay')).toBeTruthy()
    expect(queryByText('pay_direction_receive')).toBeNull()
  })

  it('opens the nearby payee cell for the get-nearby link', async () => {
    mockParams.cell = 'get-nearby'
    await act(async () => {
      await nearbyAdvisory.set()
    })
    const { UNSAFE_getByType } = draw()
    await waitFor(() => expect(UNSAFE_getByType('NearbyFlow' as never)).toBeTruthy())
    expect(UNSAFE_getByType('NearbyFlow' as never).props.role).toBe('payee')
    expect(UNSAFE_getByType('NearbyFlow' as never).props.initialRequest).toEqual({ sats: undefined })
  })

  it('opens straight on the send form for the Pay direction — no chooser', () => {
    const { UNSAFE_getByType, queryByText } = draw()
    expect(UNSAFE_getByType('UniversalSend' as never)).toBeTruthy()
    expect(queryByText('pay_cell_nearby_pay')).toBeNull()
    expect(queryByText('pay_cell_handle_pay')).toBeNull()
  })

  it('treats pay-handle and pay-address as aliases for the send form', () => {
    mockParams.cell = 'pay-address'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.openScannerOnMount).toBeFalsy()
  })

  it('opens the send form with the scanner up for pay-nearby', () => {
    mockParams.cell = 'pay-nearby'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.openScannerOnMount).toBe(true)
  })

  it('prefills the send form from a peerpay link, url extension included', () => {
    mockParams.peerpay = `peerpay:${KEY}?sats=1000&url=${encodeURIComponent('https://mb.example')}`
    const form = draw().UNSAFE_getByType('UniversalSend' as never)
    expect(form.props.initialTarget).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(form.props.initialSats).toBe(1000)
  })

  it('surfaces a malformed peerpay link as a notice on the send form', () => {
    mockParams.peerpay = 'peerpay:nope'
    expect(draw().UNSAFE_getByType('UniversalSend' as never).props.initialNotice).toContain('identity key')
  })

  it('swaps the send form for the nearby payer flow when a session code is scanned', async () => {
    await act(async () => {
      await nearbyAdvisory.set()
    })
    const { UNSAFE_getByType } = draw()
    const session = mintSession({
      identityKey: KEY,
      derivationPrefix: 'ZGV2LXByZWZpeA==',
      derivationSuffix: 'ZGV2LXN1ZmZpeA==',
      supportsAwdl: false
    })
    act(() => UNSAFE_getByType('UniversalSend' as never).props.onNearbySession(session))
    // The nearby advisory has already been acknowledged (set above), so the
    // form is swapped for the flow itself rather than waiting behind the modal.
    const nearby = await waitFor(() => UNSAFE_getByType('NearbyFlow' as never))
    expect(nearby.props.role).toBe('payer')
    expect(nearby.props.initialSession).toBe(session)
  })

  it('opens the request hub for the Get direction, titled Request Payment', () => {
    mockParams.direction = 'get'
    const { UNSAFE_getByType, getByText, queryByText } = draw()
    expect(UNSAFE_getByType('RequestHub' as never)).toBeTruthy()
    expect(getByText('local_pay_request')).toBeTruthy()
    expect(queryByText('pay_direction_receive')).toBeNull()
  })

  it('carries the hub amount into the picked method', () => {
    mockParams.direction = 'get'
    const { UNSAFE_getByType } = draw()
    const hub = UNSAFE_getByType('RequestHub' as never)
    act(() => hub.props.onChangeRequestSats('2500'))
    act(() => UNSAFE_getByType('RequestHub' as never).props.onPick('get-handle'))
    expect(UNSAFE_getByType('HandleReceive' as never).props.initialSats).toBe(2500)
  })

  it('opens a receive method directly, amount unset, when a deep link names it', () => {
    mockParams.cell = 'get-handle'
    const { UNSAFE_getByType, getByText } = draw()
    expect(UNSAFE_getByType('HandleReceive' as never).props.initialSats).toBeUndefined()
    expect(getByText('pay_method_remote_link')).toBeTruthy()
  })

  it('shows a rejected received payment through the attributed notice, not the sent one', async () => {
    // A held transaction can be rejected regardless of which side of it this
    // device was on (processOfflineActions.ts:rejectOne runs for any held
    // row). A 'sent' row has no senderIdentityKey/receivedVia — those are only
    // ever populated on the receiving side (storage/StorageExpoSQLite.ts
    // holdReqsOffline, and utils/localpay/pending.ts's processPending, which
    // backfills them after the fact) — so rendering it through the "who
    // handed you this" copy would misreport the payer's own failed payment as
    // a fraud someone else committed against them.
    const rows = [
      offlineRow({
        txid: 'aa'.repeat(32),
        role: 'received',
        status: 'rejected',
        senderIdentityKey: '02'.padEnd(66, 'c'),
        receivedVia: 'awdl'
      }),
      offlineRow({ txid: 'bb'.repeat(32), role: 'sent', status: 'rejected' })
    ]
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryAllByText } = draw()
    await findByText('pay_offline_rejected_title')
    expect(queryAllByText('pay_offline_rejected_title')).toHaveLength(1)
  })

  it('shows the payer their own rejected payment through a distinct, unattributed notice', async () => {
    const rows = [offlineRow({ txid: 'bb'.repeat(32), role: 'sent', status: 'rejected' })]
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryByText } = draw()
    await findByText('pay_offline_sent_rejected_title')
    // Never the received-side "who handed you this" copy for the user's own send.
    expect(queryByText('pay_offline_rejected_title')).toBeNull()
  })

  it('counts a queued payment toward the banner regardless of which side sent it', async () => {
    const rows = [
      offlineRow({ txid: 'cc'.repeat(32), role: 'received', status: 'queued' }),
      offlineRow({ txid: 'dd'.repeat(32), role: 'sent', status: 'posting' })
    ]
    mockOnline = false
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText } = draw()
    await findByText('pay_offline_queued')
  })

  it('surfaces a still-queued payment while online, not only while offline', async () => {
    // A queue that will never drain (a foreign ancestor no service accepts, a
    // row whose request has gone) is recorded only in the monitor's log string,
    // so /pay is the one place the user can learn about it.
    const rows = [offlineRow({ txid: 'ee'.repeat(32), role: 'received', status: 'queued' })]
    mockOnline = true
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryByText } = draw()
    await findByText('pay_offline_pending_title')
    // Not the offline card: the device has signal.
    expect(queryByText('pay_offline_title')).toBeNull()
  })

  it('keeps the send form working when the queue read itself fails', async () => {
    // The banner is advisory, never load-bearing (see app/pay.tsx's queue
    // effect). A broken read must not take the rest of the screen down with it.
    mockStorage = {
      sqliteDb: {
        getAllAsync: async () => {
          throw new Error('database is locked')
        },
        runAsync: async () => undefined,
        getFirstAsync: async () => undefined
      }
    }
    const { UNSAFE_getByType } = draw()
    await waitFor(() => expect(UNSAFE_getByType('UniversalSend' as never)).toBeTruthy())
  })
})
