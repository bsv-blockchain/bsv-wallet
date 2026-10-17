const mockResendPaymentDetails = jest.fn()
const mockReleaseParked = jest.fn()
const mockFindOffline = jest.fn()

jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn().mockImplementation(() => ({ sendMessage: jest.fn() }))
}))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  NO_MESSAGE_BOX: '__none__',
  findOfflineActionByTxid: (...a: unknown[]) => mockFindOffline(...a),
  getOnline: () => true,
  makeBeefRepair: jest.fn(() => jest.fn()),
  makeListPeerPayAction: jest.fn(() => jest.fn()),
  makeResendBeef: jest.fn(() => jest.fn()),
  releaseParkedPayment: (...a: unknown[]) => mockReleaseParked(...a),
  resendPaymentDetails: (...a: unknown[]) => mockResendPaymentDetails(...a),
  wocConfigFor: jest.fn(() => ({}))
}))
jest.mock('@bsv/expo-wallet-toolbox/core/peerpay/metadataDecryptor', () => ({ makeMetadataDecryptor: jest.fn(() => undefined) }))

import { canResend, resendPayment, storedPaymentCode } from '../src/activity/paymentHelp'

const base = {
  permissionsManager: {},
  storage: { sqliteDb: {} },
  adminOriginator: 'admin.test',
  network: 'main' as const,
  messageBoxUrl: 'https://messagebox.example'
}

beforeEach(() => jest.clearAllMocks())

describe('which payments can be sent again', () => {
  it('a sent nearby, @handle or stablecoin payment with a txid', () => {
    for (const l of ['localpay', 'peerpay', 'mandala']) expect(canResend({ incoming: false, txid: 'a'.repeat(64), labels: [l] })).toBe(true)
  })
  it('not an address payment, a received one, or one without a txid', () => {
    expect(canResend({ incoming: false, txid: 'a'.repeat(64), labels: ['legacy', 'outbound'] })).toBe(false)
    expect(canResend({ incoming: true, txid: 'a'.repeat(64), labels: ['localpay'] })).toBe(false)
    expect(canResend({ incoming: false, txid: undefined, labels: ['localpay'] })).toBe(false)
  })
})

describe('sending a payment again', () => {
  it('rebuilds a BSV payment over the message box and releases it when it was parked', async () => {
    mockResendPaymentDetails.mockResolvedValue({ ok: true })
    const out = await resendPayment({ ...base, tx: { txid: 't1', labels: ['localpay'], offlineStatus: 'parked' } })
    expect(out).toEqual({ ok: true })
    expect(mockResendPaymentDetails).toHaveBeenCalledWith(expect.objectContaining({ txid: 't1' }))
    expect(mockReleaseParked).toHaveBeenCalledWith(expect.objectContaining({ txid: 't1', isTokenHold: false }))
  })

  it('leaves a payment that is not parked alone', async () => {
    mockResendPaymentDetails.mockResolvedValue({ ok: true })
    await resendPayment({ ...base, tx: { txid: 't1', labels: ['peerpay'], offlineStatus: undefined } })
    expect(mockReleaseParked).not.toHaveBeenCalled()
  })

  it('does not release a parked payment that could not be sent', async () => {
    mockResendPaymentDetails.mockResolvedValue({ ok: false, reason: 'no_recipient' })
    const out = await resendPayment({ ...base, tx: { txid: 't1', labels: ['localpay'], offlineStatus: 'parked' } })
    expect(out).toEqual({ ok: false, reason: 'no_recipient' })
    expect(mockReleaseParked).not.toHaveBeenCalled()
  })

  it('needs a message box for BSV', async () => {
    const out = await resendPayment({ ...base, messageBoxUrl: '__none__', tx: { txid: 't1', labels: ['localpay'] } })
    expect(out).toEqual({ ok: false, reason: 'no_message_box' })
    expect(mockResendPaymentDetails).not.toHaveBeenCalled()
  })

  it('sends a stablecoin through the Mandala runtime, and marks its release as a token hold', async () => {
    const resendTransfer = jest.fn().mockResolvedValue({ ok: true })
    const out = await resendPayment({
      ...base,
      mandalaRuntime: { resendTransfer },
      tx: { txid: 't2', labels: ['mandala', 'localpay'], offlineStatus: 'parked' }
    })
    expect(out).toEqual({ ok: true })
    expect(resendTransfer).toHaveBeenCalledWith('t2', expect.anything())
    expect(mockResendPaymentDetails).not.toHaveBeenCalled()
    expect(mockReleaseParked).toHaveBeenCalledWith(expect.objectContaining({ txid: 't2', isTokenHold: true }))
  })

  it('maps an unknown core reason to a sentence it has', async () => {
    mockResendPaymentDetails.mockResolvedValue({ ok: false, reason: 'something_new' })
    const out = await resendPayment({ ...base, tx: { txid: 't1', labels: ['peerpay'] } })
    expect(out).toEqual({ ok: false, reason: 'no_record' })
  })
})

describe('a nearby payment code kept with the payment', () => {
  it('is read from the offline row', async () => {
    mockFindOffline.mockResolvedValue({ framePayload: 'bsvpayf1:abc' })
    await expect(storedPaymentCode({ sqliteDb: {} }, 't1')).resolves.toBe('bsvpayf1:abc')
  })
  it('is null without one, or when the read fails', async () => {
    mockFindOffline.mockResolvedValue({ framePayload: null })
    await expect(storedPaymentCode({ sqliteDb: {} }, 't1')).resolves.toBeNull()
    mockFindOffline.mockRejectedValue(new Error('db'))
    await expect(storedPaymentCode({ sqliteDb: {} }, 't1')).resolves.toBeNull()
    await expect(storedPaymentCode(null, 't1')).resolves.toBeNull()
  })
})
