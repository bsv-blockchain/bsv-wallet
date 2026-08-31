// Same convention as __tests__/payScreen.test.tsx and __tests__/Toast.test.tsx:
// @expo/vector-icons pulls in expo-font, which ships ESM and is not covered by
// this repo's transformIgnorePatterns exceptions, so every test that renders
// an Ionicons-using component mocks the module to a bare string component.
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

// Pulled in as a side effect of the barrel import below: its LocalStorageProvider
// chain reaches these native modules at module top level.
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

// Unlike payScreen.test.tsx and payReceivedOverlay.test.tsx, this file does NOT
// mock react-i18next: the assertions below match on real English copy ("2",
// "02cccc", "rejected"), not on translation keys, so the real i18n instance —
// initialised as a side effect of importing the barrel — has to be running.
// That module also detects a device locale; in this Jest environment no
// locale is found, so it falls back to 'en', which is what these tests need.
import '@bsv/expo-wallet-toolbox'
import i18n from 'i18next'

import React from 'react'
import { StyleSheet } from 'react-native'
import { fireEvent, render } from '@testing-library/react-native'
import OfflineNotice from '../../ui/components/pay/OfflineNotice'

// Jest in this worktree resolves `@bsv/expo-wallet-toolbox` to the main
// checkout's package, whose i18n init does not include this task's keys.
beforeAll(() => {
  i18n.addResourceBundle(
    'en',
    'translation',
    {
      request_again: 'Request again',
      send_again: 'Send again',
      copy_details: 'Copy details',
      payment_bounced_resend: 'Asked them to send this payment again',
      dismiss_rejected_payment: 'Dismissed this rejected payment'
    },
    true,
    true
  )
})

const row = (txid: string) => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid,
  seq: 1,
  role: 'received' as const,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  receivedVia: 'awdl',
  status: 'rejected' as const,
  rejectedReason: 'the network rejected the transaction as invalid',
  poisonedByTxid: txid,
  framePayload: null
})

// A payer's own held payment can be rejected too, but it carries no attribution
// — there is no counterparty to blame for a transaction the user sent themselves.
const sentRow = (txid: string) => ({
  ...row(txid),
  offlineActionId: 2,
  seq: 2,
  role: 'sent' as const,
  senderIdentityKey: null,
  receivedVia: null
})

describe('OfflineNotice', () => {
  it('renders nothing when online with an empty queue', () => {
    const { toJSON } = render(<OfflineNotice online queued={0} rejected={[]} />)
    expect(toJSON()).toBeNull()
  })

  it('says it is offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={0} rejected={[]} />)
    expect(getByText(/offline/i)).toBeTruthy()
  })

  it('reports the queued count while offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={2} rejected={[]} />)
    expect(getByText(/2/)).toBeTruthy()
  })

  // The drain can stall permanently (a foreign ancestor no service accepts, a
  // row whose request has vanished) and records that nowhere the user can see.
  // Going blank the moment signal returns would make a stuck payment look
  // exactly like a settled one.
  it('still reports a non-empty queue once back online', () => {
    const { getByText } = render(<OfflineNotice online queued={3} rejected={[]} />)
    expect(getByText(/3/)).toBeTruthy()
  })

  it('never says a queued payment has settled, online or off', () => {
    const { getByText } = render(<OfflineNotice online queued={1} rejected={[]} />)
    // The negation is the load-bearing part of the copy: "not reached the
    // network yet", never "received" or "settled".
    expect(getByText(/not reached the network yet/i)).toBeTruthy()
    expect(getByText(/nothing is settled until/i)).toBeTruthy()
  })

  it('does not double up the queue count on the offline card', () => {
    // Offline, the offline card already carries the count; a second card saying
    // the same thing is noise.
    const { queryByText } = render(<OfflineNotice online={false} queued={2} rejected={[]} />)
    expect(queryByText(/not reached the network yet/i)).toBeNull()
  })

  it('shows a rejection with its sender even when back online', () => {
    const { getByText } = render(<OfflineNotice online queued={0} rejected={[row('aa'.repeat(32))]} />)
    expect(getByText(/02cccc/i)).toBeTruthy()
    expect(getByText(/rejected/i)).toBeTruthy()
  })

  it('renders nothing online with an empty queue and no rejections of either kind', () => {
    const { toJSON } = render(<OfflineNotice online queued={0} rejected={[]} sentRejected={[]} />)
    expect(toJSON()).toBeNull()
  })

  it('shows a distinct notice for a payment the user sent that could not be delivered, unattributed', () => {
    const { getByText, queryByText } = render(
      <OfflineNotice online queued={0} rejected={[]} sentRejected={[sentRow('bb'.repeat(32))]} />
    )
    expect(getByText(/could not be delivered/i)).toBeTruthy()
    // There is no counterparty to name for the user's own failed send — this
    // must never borrow the received-side "who handed it over" copy.
    expect(queryByText(/handed over/i)).toBeNull()
  })

  it('shows a Send now button when online with a queue and fires the callback', () => {
    const onSendNow = jest.fn()
    const { getByText } = render(<OfflineNotice online queued={2} rejected={[]} onSendNow={onSendNow} />)
    fireEvent.press(getByText(/send now/i))
    expect(onSendNow).toHaveBeenCalled()
  })

  it('renders the stall detail when one exists', () => {
    const { getByText } = render(<OfflineNotice online queued={1} rejected={[]} stalled="txA has no request" />)
    expect(getByText(/txA has no request/)).toBeTruthy()
  })

  it('offers show-code only for queued sent rows that carry a frame', () => {
    const withFrame = {
      ...row('cc'.repeat(32)),
      role: 'sent' as const,
      status: 'queued' as const,
      framePayload: 'bsvpayf1:abc'
    }
    const without = { ...row('dd'.repeat(32)), role: 'sent' as const, status: 'queued' as const, framePayload: null }
    const onShowCode = jest.fn()
    const { getAllByText } = render(
      <OfflineNotice online queued={0} rejected={[]} queuedSent={[withFrame, without]} onShowCode={onShowCode} />
    )
    expect(getAllByText(/show code again/i)).toHaveLength(1)
  })

  it('exposes Request again, Copy details and Cancel on a rejected received card', () => {
    const received = row('aa'.repeat(32))
    const onRequestAgain = jest.fn()
    const onCopyDetails = jest.fn()
    const onDismiss = jest.fn()
    const { getByText, getByLabelText } = render(
      <OfflineNotice
        online
        queued={0}
        rejected={[received]}
        onRequestAgain={onRequestAgain}
        onCopyDetails={onCopyDetails}
        onDismiss={onDismiss}
      />
    )
    const request = getByLabelText(/request again/i)
    expect(request).toBeTruthy()
    expect(getByText(/request again/i)).toBeTruthy()
    const requestStyle = StyleSheet.flatten(request.props.style)
    expect(requestStyle?.minHeight).toBeGreaterThanOrEqual(44)
    expect(requestStyle?.minWidth).toBeGreaterThanOrEqual(44)

    fireEvent.press(getByText(/request again/i))
    expect(onRequestAgain).toHaveBeenCalledWith(received)

    fireEvent.press(getByText(/copy details/i))
    expect(onCopyDetails).toHaveBeenCalledWith(received)

    fireEvent.press(getByText(/^cancel$/i))
    expect(onDismiss).toHaveBeenCalledWith(received)
  })

  it('exposes Send again and Cancel on a rejected sent card, not Request again', () => {
    const sent = sentRow('bb'.repeat(32))
    const onSendAgain = jest.fn()
    const onDismiss = jest.fn()
    const { getByText, queryByText } = render(
      <OfflineNotice online queued={0} rejected={[]} sentRejected={[sent]} onSendAgain={onSendAgain} onDismiss={onDismiss} />
    )
    expect(queryByText(/request again/i)).toBeNull()
    fireEvent.press(getByText(/send again/i))
    expect(onSendAgain).toHaveBeenCalledWith(sent)
    fireEvent.press(getByText(/^cancel$/i))
    expect(onDismiss).toHaveBeenCalledWith(sent)
  })
})
