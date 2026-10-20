import { dialFailure } from '../../core/directpay'

// Shaped like @bsv/webrtpay's WebRTPayError: this package must not import it.
class WebRTPayError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly reason?: string
  ) {
    super(message ?? code)
    this.name = 'WebRTPayError'
  }
}

describe('dialFailure', () => {
  it('offline: nobody answered in the presence window', () => {
    expect(dialFailure(new WebRTPayError('peer_unreachable'))).toBe('offline')
  })

  it('rejected: their wallet answered and is not taking direct payments, or is busy', () => {
    expect(dialFailure(new WebRTPayError('rejected', 'refused', 'not_receiving'))).toBe('rejected')
    expect(dialFailure(new WebRTPayError('rejected', 'refused', 'busy'))).toBe('rejected')
  })

  it('wrong_network: a refusal because the wallets are on different networks', () => {
    expect(dialFailure(new WebRTPayError('rejected', 'refused', 'wrong_network'))).toBe('wrong_network')
  })

  it('unknown: a refusal for any other reason, or with none', () => {
    expect(dialFailure(new WebRTPayError('rejected', 'refused', 'because I said so'))).toBe('unknown')
    expect(dialFailure(new WebRTPayError('rejected'))).toBe('unknown')
  })

  it('unavailable: the signal could not be posted', () => {
    expect(dialFailure(new WebRTPayError('unavailable'))).toBe('unavailable')
  })

  it('timeout: they answered but the link did not come up', () => {
    expect(dialFailure(new WebRTPayError('timeout'))).toBe('timeout')
  })

  describe('aborted', () => {
    it('for a native or DOM abort', () => {
      const abort = new Error('The operation was aborted')
      abort.name = 'AbortError'
      expect(dialFailure(abort)).toBe('aborted')
      expect(dialFailure({ name: 'AbortError' })).toBe('aborted')
      expect(dialFailure({ code: 'ABORT_ERR' })).toBe('aborted')
    })

    it('for the package\'s "Dial cancelled" (a closed dial)', () => {
      expect(dialFailure(new WebRTPayError('closed', 'Dial cancelled'))).toBe('aborted')
    })

    it('not for a link that closed some other way', () => {
      expect(dialFailure(new WebRTPayError('closed', 'The connection closed'))).toBe('unknown')
      expect(dialFailure(new WebRTPayError('closed'))).toBe('unknown')
    })
  })

  it('unknown: any other code of the package', () => {
    for (const code of ['protocol', 'auth_failed', 'invalid_code', 'invalid_payment', 'rate_limited', 'unsupported']) {
      expect(dialFailure(new WebRTPayError(code))).toBe('unknown')
    }
  })

  it('reads an error that lost its prototype (copied across a bridge) by its properties', () => {
    expect(dialFailure({ name: 'WebRTPayError', code: 'peer_unreachable', message: 'x' })).toBe('offline')
    expect(dialFailure({ name: 'WebRTPayError', code: 'rejected', reason: 'not_receiving' })).toBe('rejected')
  })

  it("does not take another error's `code` for the package's", () => {
    const other = Object.assign(new Error('x'), { code: 'timeout' })
    expect(dialFailure(other)).toBe('unknown')
    expect(dialFailure(Object.assign(new Error('x'), { code: 'peer_unreachable' }))).toBe('unknown')
  })

  it('unknown: anything that is not an error object', () => {
    for (const value of [new Error('boom'), 'peer_unreachable', 42, null, undefined, {}, []]) {
      expect(dialFailure(value)).toBe('unknown')
    }
  })
})
