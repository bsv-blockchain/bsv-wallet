/**
 * The toolbox never imports `@bsv/webrtpay` (an optional peer dependency; see
 * core/directpay/webrtpay.ts), so it writes out the shapes it calls. These checks are at type
 * level, run by `tsc --noEmit -p .`: the real package must fit them, and message-box-client's
 * PeerPayClient must carry signals for MessageBoxSignaler as it is, with no adapter. The test
 * itself also loads the real package through the lazy require, to show jest can transform it.
 */
import type { PeerPayClient } from '@bsv/message-box-client'
import type * as WebRTPay from '@bsv/webrtpay'
import {
  loadWebRTPay,
  setWebRTPayForTests,
  type MessageBoxLike,
  type WebRTPayModule
} from '../../core/directpay/webrtpay'

export const realModuleFits = (m: typeof WebRTPay): WebRTPayModule => m
export const peerPayClientIsMessageBoxLike = (client: PeerPayClient): MessageBoxLike => client
export const toolboxMessageBoxFitsTheSignaler = (client: MessageBoxLike): WebRTPay.MessageBoxLike => client

describe('@bsv/webrtpay as the toolbox loads it', () => {
  afterEach(() => setWebRTPayForTests(undefined))

  it('requires the installed package lazily and finds what the toolbox calls', () => {
    setWebRTPayForTests(undefined)
    const m = loadWebRTPay()
    expect(m).not.toBeNull()
    expect(typeof m!.DirectPayClient).toBe('function')
    expect(typeof m!.RelaySignaler).toBe('function')
    expect(typeof m!.MessageBoxSignaler).toBe('function')
    expect(typeof m!.acceptDirectPayment).toBe('function')
    expect(typeof m!.validatePaymentToken).toBe('function')
    expect(m!.MAX_DIRECT_TRANSACTION_BYTES).toBeGreaterThan(1_000_000)
    expect(new m!.WebRTPayError('rejected', 'no').code).toBe('rejected')
  })
})
