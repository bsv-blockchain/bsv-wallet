// nearby.ts re-exports holdSentPaymentOffline from the package's own root
// (@bsv/expo-wallet-toolbox), which pulls in the full core/index.ts surface —
// including LocalStorageProvider's secrets stack, which touches these two
// native modules at import time. Same mocking requirement as
// packageResolution.test.ts and __tests__/secrets/*.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import * as nearby from '../../core/pay/rails/nearby'
import * as session from '../../core/localpay/session'
import * as verify from '../../core/localpay/verify'
import * as codec from '../../core/localpay/codec'
import * as pending from '../../core/localpay/pending'
import * as build from '../../core/localpay/build'
import { awdlTransport } from '../../core/localpay/transport/awdl'
import { localSupportsAwdl, selectTransport } from '../../core/localpay/transport/select'

describe('nearby rail adapter', () => {
  it('re-exports the localpay functions by identity, so nothing is reimplemented', () => {
    expect(nearby.mintSession).toBe(session.mintSession)
    expect(nearby.encodeSession).toBe(session.encodeSession)
    expect(nearby.decodeSession).toBe(session.decodeSession)
    expect(nearby.frameToQr).toBe(codec.frameToQr)
    expect(nearby.frameBytesFromQr).toBe(codec.frameBytesFromQr)
    expect(nearby.FRAME_BLOCK_BYTES).toBe(codec.FRAME_BLOCK_BYTES)
    expect(nearby.verifyFramePayment).toBe(verify.verifyFramePayment)
    expect(nearby.FrameVerifyError).toBe(verify.FrameVerifyError)
    expect(nearby.savePending).toBe(pending.savePending)
    expect(nearby.processPending).toBe(pending.processPending)
    expect(nearby.isSessionSpent).toBe(pending.isSessionSpent)
    expect(nearby.markSessionSpent).toBe(pending.markSessionSpent)
    expect(nearby.buildPaymentFrame).toBe(build.buildPaymentFrame)
    expect(nearby.finalizeDelivery).toBe(build.finalizeDelivery)
    expect(nearby.awdlTransport).toBe(awdlTransport)
    expect(nearby.selectTransport).toBe(selectTransport)
    expect(nearby.localSupportsAwdl).toBe(localSupportsAwdl)
  })
})
