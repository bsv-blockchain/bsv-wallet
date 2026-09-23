/**
 * The token half of the activity list, the withdrawal alert, and the hook
 * both read from.
 *
 * The rules under test are the ones that decide whether a number on screen is
 * true: a token row never falls through to the satoshi figure, its face comes
 * from its own counterparty key rather than the underlying BSV tx (and falls
 * back to the plain arrow when it has none), an unknown balance is a spinner
 * and not a zero, and money that left the wallet is announced exactly once.
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('|')}` : key,
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('react-native-qrcode-svg', () => 'QRCode')
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {}
}))
let mockWalletCtx: Record<string, unknown> = {}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => mockWalletCtx
}))

import React from 'react'
import { act, render, renderHook, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import ActivityRow from '../../ui/components/wallet/ActivityRow'
import Sigil from '../../ui/components/ui/Sigil'
import PaymentSuccessOverlay from '../../ui/components/pay/PaymentSuccessOverlay'
import { announceEviction, evictionsFrom } from '../../ui/components/wallet/tokenEviction'
import { MandalaProvider, useMandala, useTokenActivity } from '../../ui/hooks/useMandala'
import { tokenStatusDetailKey, tokenStatusKey, tokenStatusTone } from '../../ui/tokenStatus'
import { homeBadges } from '../../ui/screens/homeBadges'
import { activityRow, balanceOf, makeFakeMandala, settlementRow, USDX } from '../__mocks__/fakeMandalaRuntime'

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

beforeEach(() => {
  mockWalletCtx = {}
})

describe('tokenStatus', () => {
  it('names every settlement state the runtime can report', () => {
    expect(tokenStatusKey('settling')).toBe('token_status_settling')
    expect(tokenStatusKey('settled')).toBe('token_status_settled')
    expect(tokenStatusKey('refused')).toBe('token_status_refused')
    expect(tokenStatusKey('reversed')).toBe('token_status_reversed')
    expect(tokenStatusKey('stuck')).toBe('token_status_stuck')
  })

  it('keeps green for confirmed money only — settling is ordinary, not a warning', () => {
    expect(tokenStatusTone('settled')).toBe('positive')
    expect(tokenStatusTone('settling')).toBe('neutral')
    expect(tokenStatusTone('stuck')).toBe('warning')
    expect(tokenStatusTone('refused')).toBe('error')
  })

  it('explains a refusal from the side it happened on', () => {
    expect(tokenStatusDetailKey('refused', 'sent')).toBe('token_err_refused')
    expect(tokenStatusDetailKey('refused', 'received')).toBe('token_recv_reversed')
    expect(tokenStatusDetailKey('settled', 'sent')).toBeNull()
  })
})

describe('ActivityRow with a token', () => {
  const action = {
    txid: 'a'.repeat(64),
    satoshis: -64,
    status: 'completed',
    description: 'Receive 4000 of 615a06ab….0',
    isOutgoing: true,
    labels: ['mandala', 'transfer'],
    version: 1,
    lockTime: 0
  } as never

  const drawRow = (token?: React.ComponentProps<typeof ActivityRow>['token']) =>
    wrap(
      <ActivityRow
        currency="BSV"
        action={action}
        rowKey="row"
        expanded={false}
        busy={false}
        onToggle={jest.fn()}
        onExplorer={jest.fn()}
        onRefreshTx={jest.fn()}
        onAbort={jest.fn()}
        token={token}
      />
    )

  it('replaces the lib\'s developer description and never prints the BSV movement', () => {
    const s = drawRow({
      title: 'token_row_sent:USDX',
      amount: { value: '−25.00', unit: 'USDX' },
      incoming: false,
      statusText: 'token_status_settling'
    })
    expect(s.getByText('token_row_sent:USDX')).toBeTruthy()
    expect(s.queryByText(/Receive 4000 of/)).toBeNull()
    // One composed label for the figure and its unit, as everywhere else.
    expect(s.getByLabelText('−25.00 USDX')).toBeTruthy()
    expect(s.getByLabelText('token_row_sent:USDX, −25.00 USDX')).toBeTruthy()
    // −64 sats is the fee, not the payment, and a plausible wrong number is
    // worse than a blank.
    expect(s.queryByText(/64/)).toBeNull()
  })

  it('says the amount is unavailable rather than falling through to satoshis', () => {
    const s = drawRow({ title: 'token_row_received:USDX', incoming: true })
    expect(s.getByText('token_row_amount_pending')).toBeTruthy()
  })

  it('carries the settlement words in the status line', () => {
    const s = drawRow({
      title: 'token_row_received:USDX',
      amount: { value: '+40.00', unit: 'USDX' },
      incoming: true,
      statusText: 'token_status_settling'
    })
    expect(s.getByText(/token_status_settling/)).toBeTruthy()
  })

  it('is byte-identical to the row it always was when no token is passed', () => {
    const plain = drawRow()
    expect(plain.getByText('Receive 4000 of 615a06ab….0')).toBeTruthy()
  })

  // The wallet action's own labels/senderIdentityKey describe the underlying
  // BSV coin-selection tx, not who the token moved with — so a token row's
  // face has to come from its OWN counterparty key (TokenActivityRow's
  // `counterpartyKey`), the same generative sigil a BSV row draws, never the
  // plain get-paid/arrow icon it used to be stuck with.
  it('draws the same generative identity image as a BSV row when the counterparty is known', () => {
    const s = drawRow({
      title: 'token_row_received:USDX',
      amount: { value: '+40.00', unit: 'USDX' },
      incoming: true,
      counterpartyKey: '02' + 'ab'.repeat(32),
      statusText: 'token_status_settled'
    })
    expect(s.UNSAFE_getByType(Sigil)).toBeTruthy()
  })

  it('falls back to the plain direction icon only when the row names no counterparty', () => {
    const s = drawRow({
      title: 'token_row_received:USDX',
      amount: { value: '+40.00', unit: 'USDX' },
      incoming: true,
      statusText: 'token_status_settled'
    })
    expect(s.UNSAFE_queryByType(Sigil)).toBeNull()
  })
})

describe('the withdrawal alert', () => {
  it('is raised for credited money that is gone, and for nothing else', () => {
    const rows = [
      activityRow({ txid: 'r1', status: 'reversed' }),
      activityRow({ txid: 'r2', status: 'refused' }),
      activityRow({ txid: 'r3', status: 'settled' }),
      // A refused SEND never left, so the balance is unchanged and there is
      // nothing to announce.
      activityRow({ txid: 'r4', role: 'sent', status: 'refused' })
    ]
    expect(evictionsFrom(rows, []).map(e => e.txid)).toEqual(['r1', 'r2'])
  })

  it('is raised once — a seen transaction is never announced again', () => {
    const rows = [activityRow({ txid: 'r1', status: 'reversed' })]
    expect(evictionsFrom(rows, ['r1'])).toEqual([])
  })

  it('names the actor and the figure', async () => {
    const alerts: { title: string; message?: string }[] = []
    jest.spyOn(require('../../ui/components/ui/AlertCard'), 'showAlert').mockImplementation((async (o: never) => {
      alerts.push(o)
      return 'ok'
    }) as never)
    const t = ((k: string, v?: Record<string, unknown>) =>
      v ? `${k}:${Object.values(v).join('|')}` : k) as never
    await announceEviction(t, { txid: 'r1', ticker: 'USDX', issuer: 'Acme Bank', baseUnits: 4000, decimals: 2 })
    expect(alerts[0]).toEqual({
      title: 'token_evicted_title:USDX',
      message: 'token_evicted_body:Acme Bank|40.00|USDX'
    })
    jest.restoreAllMocks()
  })
})

describe('PaymentSuccessOverlay in token mode', () => {
  it('renders the token figure and the settlement sentence, not a satoshi amount', () => {
    const s = wrap(
      <PaymentSuccessOverlay
        direction="sent"
        amount={0}
        amountText="25.00 USDX"
        statusNote="token_sent_settling_unnamed:Acme Bank"
        onDismiss={jest.fn()}
      />
    )
    expect(s.getByText('25.00 USDX')).toBeTruthy()
    expect(s.getByText('token_sent_settling_unnamed:Acme Bank')).toBeTruthy()
  })

  it('gives a sent payment its own not-broadcast line, not the received one', () => {
    const s = wrap(<PaymentSuccessOverlay direction="sent" amount={10} broadcast={false} onDismiss={jest.fn()} />)
    expect(s.getByText('pay_sent_not_broadcast')).toBeTruthy()
    expect(s.queryByText('pay_received_not_broadcast')).toBeNull()
  })

  it('discloses the issuer on a first hold', () => {
    const s = wrap(
      <PaymentSuccessOverlay
        direction="received"
        amount={0}
        amountText="+40.00 USDX"
        firstHoldNote="token_first_hold:USDX|Acme Bank"
        onDismiss={jest.fn()}
      />
    )
    expect(s.getByText('token_first_hold:USDX|Acme Bank')).toBeTruthy()
  })
})

describe('homeBadges', () => {
  it('surfaces token payments that have been waiting too long', () => {
    expect(
      homeBadges({ attention: 0, unsent: 0, offlineQueued: 0, offlineRejected: 0, tokenAttention: 2 })
    ).toEqual([{ kind: 'token_attention', count: 2 }])
  })

  it('is unchanged for a wallet with no token work', () => {
    expect(homeBadges({ attention: 1, unsent: 0, offlineQueued: 0, offlineRejected: 0 })).toEqual([
      { kind: 'attention', count: 1 }
    ])
  })
})

describe('useMandala', () => {
  it('reports stablecoins as unavailable with no runtime, and reads nothing', async () => {
    const { result } = renderHook(() => useMandala(), {
      wrapper: ({ children }) => <MandalaProvider runtime={null}>{children}</MandalaProvider>
    })
    await settle()
    expect(result.current.available).toBe(false)
    expect(result.current.balances).toBeNull()
    expect(result.current.assets).toEqual([])
  })

  it('treats a runtime that says it is unavailable as none at all (the chain gate)', async () => {
    const runtime = makeFakeMandala({ available: false })
    const { result } = renderHook(() => useMandala(), {
      wrapper: ({ children }) => <MandalaProvider runtime={runtime}>{children}</MandalaProvider>
    })
    await settle()
    expect(result.current.available).toBe(false)
    expect(runtime.balances).not.toHaveBeenCalled()
  })

  it('starts UNKNOWN, then reports the balances and the stuck rows', async () => {
    const runtime = makeFakeMandala({ balances: [balanceOf()], stuck: [settlementRow()] })
    const { result } = renderHook(() => useMandala(), {
      wrapper: ({ children }) => <MandalaProvider runtime={runtime}>{children}</MandalaProvider>
    })
    expect(result.current.balances).toBeNull()
    await settle()
    expect(result.current.balances?.[0].asset.ticker).toBe('USDX')
    expect(result.current.assets).toHaveLength(1)
    expect(result.current.stuck).toHaveLength(1)
  })

  it('keeps the last figure when a refresh fails, rather than blanking the screen', async () => {
    const runtime = makeFakeMandala({ balances: [balanceOf()] })
    const { result } = renderHook(() => useMandala(), {
      wrapper: ({ children }) => <MandalaProvider runtime={runtime}>{children}</MandalaProvider>
    })
    await settle()
    runtime.balances.mockRejectedValueOnce(new Error('overlay down'))
    await act(async () => {
      result.current.refresh()
    })
    await settle()
    expect(result.current.balances?.[0].baseUnits).toBe(124000)
  })

  it('repaints when the runtime says money moved', async () => {
    const runtime = makeFakeMandala({ balances: [balanceOf()] })
    const { result } = renderHook(() => useMandala(), {
      wrapper: ({ children }) => <MandalaProvider runtime={runtime}>{children}</MandalaProvider>
    })
    await settle()
    runtime.balances.mockResolvedValueOnce([balanceOf(USDX, 224000)])
    await act(async () => {
      runtime.emit()
    })
    await settle()
    await waitFor(() => expect(result.current.balances?.[0].baseUnits).toBe(224000))
  })

  it('reads activity only through the runtime, and reports null until it lands', async () => {
    const runtime = makeFakeMandala({ activity: [activityRow()] })
    const { result } = renderHook(() => useTokenActivity(), {
      wrapper: ({ children }) => <MandalaProvider runtime={runtime}>{children}</MandalaProvider>
    })
    expect(result.current.rows).toBeNull()
    await settle()
    expect(result.current.rows).toHaveLength(1)
    expect(runtime.activity).toHaveBeenCalled()
  })
})
