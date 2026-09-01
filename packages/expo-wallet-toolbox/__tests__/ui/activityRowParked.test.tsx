// Same convention as offlineNotice.test.tsx: @expo/vector-icons reaches
// expo-font (untransformed ESM), so it is mocked to bare string components.
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  typography: { subhead: {}, footnote: {} },
  useTheme: () => ({ colors: new Proxy({}, { get: (_t, k) => String(k) }) }),
  useWallet: () => ({ settings: { currency: 'BSV' } }),
  // useContext needs a real context object, not a stand-in.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExchangeRateContext: require('react').createContext({ satoshisPerUSD: 5_000_000 }),
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
  radii: { sm: 6, md: 10, lg: 14, pill: 999 },
  formatAmount: () => '1,000 sats',
  formatAmountParts: () => ({ value: '-1,000', unit: 'sats' })
}))

import React from 'react'
import { render } from '@testing-library/react-native'
import ActivityRow, { type ActivityAction } from '../../ui/components/wallet/ActivityRow'
import { txStatusView } from '../../ui/txStatus'

const TXID = 'aa'.repeat(32)

const action = (over: Partial<ActivityAction> = {}): ActivityAction =>
  ({
    txid: TXID,
    satoshis: -1000,
    status: 'nosend',
    isOutgoing: true,
    description: 'Nearby payment',
    labels: ['localpay'],
    reference: 'ref-1',
    created_at: '2026-09-01T10:00:00.000Z',
    ...over
  }) as ActivityAction

function chips(offlineStatus?: string, over: Partial<ActivityAction> = {}) {
  const noop = () => {}
  return render(
    <ActivityRow
      action={action(over)}
      rowKey="k"
      offlineStatus={offlineStatus}
      expanded
      busy={false}
      onToggle={noop}
      onExplorer={noop}
      onRefreshTx={noop}
      onAbort={noop}
      onSendPaymentDetails={noop}
      onSendAgain={noop}
      onCancelParked={noop}
    />
  )
}

it('offers only a remote resend and cancel on a parked payment', () => {
  const r = chips('parked')
  // A parked payment is not on chain: an explorer link would 404 and a Refresh
  // would ask the network about a transaction it has never seen.
  expect(r.queryByText('WoC')).toBeNull()
  expect(r.queryByText('tx_action_refresh_short')).toBeNull()
  // Resend is the message-box rail, not a re-run of the nearby hand-over.
  expect(r.getByLabelText('send_payment_details_again')).toBeTruthy()
  expect(r.getByLabelText('pay_parked_cancel')).toBeTruthy()
})

it('keeps the usual chips on a payment that was actually sent', () => {
  const r = chips(undefined, { status: 'unproven' })
  expect(r.getByText('WoC')).toBeTruthy()
  expect(r.getByText('tx_action_refresh_short')).toBeTruthy()
  expect(r.queryByLabelText('pay_parked_cancel')).toBeNull()
})

it('labels a parked row for what it is, not just "not sent"', () => {
  expect(txStatusView('nosend', 'parked')).toEqual({ key: 'tx_status_parked', tone: 'attention' })
})

it('says what the spinner is waiting on', () => {
  const noop = () => {}
  const r = render(
    <ActivityRow
      action={action()}
      rowKey="k"
      offlineStatus="parked"
      expanded
      busy
      busyLabel="Sending via message box"
      onToggle={noop}
      onExplorer={noop}
      onRefreshTx={noop}
      onAbort={noop}
      onSendPaymentDetails={noop}
      onSendAgain={noop}
      onCancelParked={noop}
    />
  )
  expect(r.getByText('Sending via message box')).toBeTruthy()
  // The chips are replaced by the spinner while it runs.
  expect(r.queryByLabelText('pay_parked_cancel')).toBeNull()
})
