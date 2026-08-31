import { userFacingPayError } from '../../core/pay/userError'

describe('userFacingPayError', () => {
  it('maps WERR_REVIEW_ACTIONS to Check Wallet', () => {
    expect(userFacingPayError(new Error('WERR_REVIEW_ACTIONS: review actions'))).toEqual({
      key: 'error_review_actions',
      offerWalletCheck: true
    })
  })

  it('maps a review-actions message without the code', () => {
    expect(userFacingPayError('Need to review actions before creating a new one')).toEqual({
      key: 'error_review_actions',
      offerWalletCheck: true
    })
  })

  it('does not offer Check Wallet for an ordinary wallet error', () => {
    expect(userFacingPayError(new Error('insufficient funds'))).toEqual({
      key: 'unknown_error',
      offerWalletCheck: false
    })
  })
})
