import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import UniversalSend from '../../ui/components/pay/UniversalSend'
import {
  OUTBOX_KEY,
  getOutboxEntries,
  markOutboxSent,
  quarantineImportedOutbox,
  saveOutboxEntry,
  type OutboxEntry
} from '../../core/peerpay/outbox'
import { sender, signedPayment } from '../__helpers__/signedPeerPay'

const mockToast = jest.fn()
const mockRetry = jest.fn()
const mockCancel = jest.fn(async (..._args: unknown[]) => {})
const mockPrompt = jest.fn(async (..._args: unknown[]) => 'cancel')
const mockChoice = jest.fn(async (..._args: unknown[]) => 'cancel')
const mockAlert = jest.fn(async (..._args: unknown[]) => 'cancel')
const mockRouter = { push: jest.fn() }
let mockOfferWalletCheck = false
let mockClient: object | null = {}
let mockWallet: { getPublicKey: jest.Mock }
let mockStorage: {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}
const mockT = (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key)
const mockRecipient = {
  selectedIdentity: null,
  target: null,
  inputText: '',
  inlineError: null,
  isSearching: false,
  searchResults: [],
  searchError: null,
  scannerVisible: false,
  clearSearchError: jest.fn(),
  openScanner: jest.fn(),
  onChangeText: jest.fn(),
  selectIdentity: jest.fn(),
  clearRecipient: jest.fn(),
  setScannerVisible: jest.fn(),
  onScan: jest.fn()
}
const mockMandala = { available: false, balances: [], runtime: null, refresh: jest.fn() }

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  ...jest.requireActual('../../core/peerpay/outbox'),
  useTheme: () => ({ colors: jest.requireActual('../../core/theme/tokens').lightColors }),
  useWallet: () => ({ walletUserId: null, selectedNetwork: 'main' }),
  useWalletManagers: () => ({
    managers: { permissionsManager: mockWallet },
    adminOriginator: 'admin.test',
    storage: mockStorage
  }),
  useWalletStatus: () => ({ walletBuilt: true }),
  formatSatoshisAsBsvDecimal: (amount: number) => String(amount),
  CONSEQUENCE_KEYS: { address: 'address' },
  NO_MESSAGE_BOX: 'noMessageBox',
  getHandleRegistryConfig: () => null,
  makePeerPayClient: () => mockClient,
  retryDelivery: (...args: unknown[]) => mockRetry(...args),
  cancelOutboxPayment: (...args: unknown[]) => mockCancel(...args),
  isMessageBoxNetworkError: (error: Error | string) =>
    (typeof error === 'string' ? error : error?.message) === 'network failed',
  listPendingResendRequests: async () => ({ pending: [] }),
  makeListPeerPayAction: () => jest.fn(),
  haptics: { confirm: jest.fn(), error: jest.fn() }
}))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('expo-router', () => ({ router: mockRouter }))
jest.mock('../../ui/components/QRScanner', () => 'QRScanner')
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => <Text>{children} sats</Text> }
})
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return { __esModule: true, default: ({ children, ...props }: any) => <Pressable {...props}>{children}</Pressable> }
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...args: unknown[]) => mockAlert(...args) }))
jest.mock('../../ui/components/ui/ChoiceSheet', () => ({
  showChoiceSheet: (...args: unknown[]) => mockChoice(...args)
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }))
jest.mock('../../ui/screens/WalletCheckScreen', () => ({
  promptCheckWallet: (...args: unknown[]) => mockPrompt(...args)
}))
jest.mock('../../core/directpay/DirectPayProvider', () => ({ useDirectPay: () => ({ canSendDirect: false }) }))
jest.mock('../../core/directpay/payFlow', () => ({ fallbackPrompt: jest.fn(), payIdentity: jest.fn() }))
jest.mock('../../core/pay/userError', () => ({
  userFacingPayError: () => ({ offerWalletCheck: mockOfferWalletCheck })
}))
jest.mock('../../ui/components/pay/PayForm', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    PayField: ({ children }: any) => <View>{children}</View>,
    PayAmountField: () => null,
    PayCta: () => null,
    ConsequenceNote: () => null
  }
})
jest.mock('../../ui/components/pay/PaymentSuccessOverlay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ amount }: any) => <Text>payment-success:{amount}</Text> }
})
jest.mock('../../ui/components/pay/ResultBanner', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/pay/RecipientField', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/pay/StepBar', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://message.example' })
}))
jest.mock('../../ui/components/pay/useRecipientInput', () => ({ useRecipientInput: () => mockRecipient }))
jest.mock('../../ui/hooks/useMandala', () => ({
  useMandala: () => mockMandala,
  useAssetStatus: () => ({ status: null })
}))
jest.mock('../../ui/hooks/useSpendableBalance', () => ({ useSpendableBalance: () => 10000 }))
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => null }))
jest.mock('../../ui/components/wallet/ContactSigil', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/tokenFormat', () => ({
  formatTokenAmount: String,
  formatTokenAmountWithUnit: String,
  shortAssetId: String,
  tokenUnitsFromField: () => undefined
}))
jest.mock('../../core/identity/handleRegistry/client', () => ({ createHandleRegistryClient: jest.fn() }))

let held: OutboxEntry
beforeEach(async () => {
  jest.clearAllMocks()
  mockOfferWalletCheck = false
  mockClient = {}
  mockWallet = { getPublicKey: jest.fn(sender.getPublicKey.bind(sender)) }
  const values = new Map<string, string>()
  mockStorage = {
    getKeyValue: async key => values.get(key),
    setKeyValue: async (key, value) => {
      values.set(key, value)
    }
  }
  await saveOutboxEntry(mockStorage, await signedPayment())
  await quarantineImportedOutbox(mockStorage)
  ;[held] = await getOutboxEntries(mockStorage)
  mockRetry.mockReset().mockImplementation(async ({ storage, entry }) => {
    await markOutboxSent(storage, entry.id)
  })
})
async function form() {
  const screen = render(<UniversalSend onNearbySession={jest.fn()} />)
  await waitFor(() => expect(screen.getAllByText('review_imported_payment').length).toBeGreaterThan(0))
  return screen
}
const review = async (screen: ReturnType<typeof render>) => {
  const labels = screen.getAllByText('review_imported_payment')
  await act(async () => {
    fireEvent.press(labels[labels.length - 1])
  })
}
const send = async (screen: ReturnType<typeof render>) => {
  await act(async () => {
    fireEvent.press(screen.getByText('send'))
  })
}

test('the real parent masks imported fields and never retries before checked terms and a separate Send', async () => {
  const screen = await form()
  expect(screen.queryByText('17 sats')).toBeNull()
  expect(screen.queryByText(new RegExp(held.recipient))).toBeNull()
  expect(mockRetry).not.toHaveBeenCalled()
  await review(screen)
  expect(
    screen.getByText(mockT('review_imported_payment_detail', { amount: 17, recipient: held.recipient }))
  ).toBeTruthy()
  expect(mockWallet.getPublicKey).toHaveBeenCalledTimes(1)
  expect(mockRetry).not.toHaveBeenCalled()
  await send(screen)
  expect(mockWallet.getPublicKey).toHaveBeenCalledTimes(2)
  expect(mockRetry).toHaveBeenCalledWith(
    expect.objectContaining({
      entry: expect.objectContaining({ status: 'unsent', recipient: held.recipient, token: held.token })
    })
  )
  expect(screen.getByText('payment-success:17')).toBeTruthy()
  expect(mockAlert).not.toHaveBeenCalled()
})

test('canceling the inline review keeps the token held without retry or native approval dialog', async () => {
  const screen = await form()
  await review(screen)
  await act(async () => {
    fireEvent.press(screen.getByText('cancel'))
  })
  expect((await getOutboxEntries(mockStorage))[0].status).toBe('import_hold')
  expect(mockRetry).not.toHaveBeenCalled()
  expect(mockCancel).not.toHaveBeenCalled()
  expect(mockAlert).not.toHaveBeenCalled()
})

test('invalid imported display fields stay masked and the parent reports validation failure', async () => {
  await mockStorage.setKeyValue(
    OUTBOX_KEY,
    JSON.stringify([{ ...held, recipient: 123, token: { ...held.token, amount: 999 } }])
  )
  const screen = await form()
  await review(screen)
  expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/^retry_failed:/), { type: 'error' })
  expect(mockRetry).not.toHaveBeenCalled()
  expect(screen.queryByText('999 sats')).toBeNull()
  expect((await getOutboxEntries(mockStorage))[0].status).toBe('import_hold')
})

test('the parent refuses release when the stored snapshot changes after review', async () => {
  const screen = await form()
  await review(screen)
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, recipientHost: 'https://changed.example' }]))
  await send(screen)
  expect(mockRetry).not.toHaveBeenCalled()
  expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/review it again/), { type: 'error' })
})

test.each([new Error('network failed'), new Error('delivery refused'), {}])(
  'the parent reports a delivery error after fresh approval: %p',
  async error => {
    mockRetry.mockRejectedValueOnce(error)
    const screen = await form()
    await review(screen)
    await send(screen)
    expect(mockRetry).toHaveBeenCalledTimes(1)
    expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/^retry_failed:/), { type: 'error' })
  }
)

test('wallet-check errors after approval use the existing wallet-check flow', async () => {
  mockOfferWalletCheck = true
  mockRetry.mockRejectedValueOnce(new Error('wallet needs review'))
  const screen = await form()
  await review(screen)
  await send(screen)
  expect(mockPrompt).toHaveBeenCalledTimes(1)
  expect(mockToast).not.toHaveBeenCalled()
})

test('ordinary unsent rows keep their checked amount and delegate the Retry button', async () => {
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, status: 'unsent' }]))
  const screen = render(<UniversalSend onNearbySession={jest.fn()} />)
  await waitFor(() => expect(screen.getByText('retry')).toBeTruthy())
  expect(screen.getByText('17 sats')).toBeTruthy()
  await act(async () => {
    fireEvent.press(screen.getByText('retry'))
  })
  expect(mockRetry).toHaveBeenCalledTimes(1)
})

test('ordinary Cancel and held-row Cancel both retain history when the cancellation dialog is dismissed', async () => {
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, status: 'unsent' }]))
  const screen = render(<UniversalSend onNearbySession={jest.fn()} />)
  await waitFor(() => expect(screen.getByText('retry')).toBeTruthy())
  await act(async () => {
    fireEvent.press(screen.getByText('cancel'))
  })
  expect(mockAlert).toHaveBeenCalledTimes(1)
  expect(mockCancel).not.toHaveBeenCalled()
  screen.unmount()
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([held]))
  const heldScreen = await form()
  await act(async () => {
    fireEvent.press(heldScreen.getByText('cancel'))
  })
  expect(mockAlert).toHaveBeenCalledTimes(2)
  expect(mockCancel).not.toHaveBeenCalled()
})

test('a Finish choice on imported delivered history cannot bypass its fresh review', async () => {
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, delivered: true }]))
  mockChoice.mockResolvedValueOnce('finish')
  const screen = await form()
  await act(async () => {
    fireEvent.press(screen.getByText('cancel'))
  })
  expect(mockRetry).not.toHaveBeenCalled()
  expect((await getOutboxEntries(mockStorage))[0].status).toBe('import_hold')
})

test('a missing delivery client prevents transmission after valid fresh approval', async () => {
  mockClient = null
  const screen = await form()
  await review(screen)
  await send(screen)
  expect(mockRetry).not.toHaveBeenCalled()
  expect(mockToast).toHaveBeenCalledWith('message_box_off_hint', { type: 'error' })
})

test('an in-flight ordinary retry displays its existing busy state', async () => {
  await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, status: 'unsent' }]))
  let resolve!: () => void
  mockRetry.mockImplementationOnce(
    () =>
      new Promise<void>(res => {
        resolve = res
      })
  )
  const screen = render(<UniversalSend onNearbySession={jest.fn()} />)
  await waitFor(() => expect(screen.getByText('retry')).toBeTruthy())
  act(() => {
    fireEvent.press(screen.getByText('retry'))
  })
  await waitFor(() => expect(screen.getByText('resending')).toBeTruthy())
  await act(async () => {
    resolve()
  })
})

test.each(['network failed', 'previous delivery failed'])(
  'ordinary stored delivery errors remain visible: %s',
  async lastError => {
    await mockStorage.setKeyValue(OUTBOX_KEY, JSON.stringify([{ ...held, status: 'unsent', lastError }]))
    const screen = render(<UniversalSend onNearbySession={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByText(lastError === 'network failed' ? 'message_box_unreachable' : lastError)).toBeTruthy()
    )
    expect(mockRetry).not.toHaveBeenCalled()
  }
)
