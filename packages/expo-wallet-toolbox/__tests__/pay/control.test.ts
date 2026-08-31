import { PAYMENT_CONTROL_BOX, parseControlMessage, sendControlMessage } from '../../core/peerpay/control'

describe('parseControlMessage', () => {
  it('accepts a resend_request', () => {
    expect(parseControlMessage({ type: 'resend_request', txid: 'aa', reason: 'corrupt' })).toEqual({
      type: 'resend_request',
      txid: 'aa',
      reason: 'corrupt'
    })
  })

  it('ignores unknown types', () => {
    expect(parseControlMessage({ type: 'nope', txid: 'aa' })).toBeUndefined()
  })

  it('accepts a payment_cancelled', () => {
    expect(parseControlMessage({ type: 'payment_cancelled', txid: 'aa' })).toEqual({
      type: 'payment_cancelled',
      txid: 'aa'
    })
  })

  it('keeps an optional messageId on resend_request', () => {
    expect(
      parseControlMessage({ type: 'resend_request', txid: 'aa', reason: 'uncreditible', messageId: 'm1' })
    ).toEqual({
      type: 'resend_request',
      txid: 'aa',
      reason: 'uncreditible',
      messageId: 'm1'
    })
  })
})

describe('sendControlMessage', () => {
  it('posts JSON to payment_control', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    await sendControlMessage(
      { sendMessage },
      { recipient: '02aa', message: { type: 'resend_request', txid: 'aa', reason: 'uncreditible' } }
    )
    expect(sendMessage).toHaveBeenCalledWith({
      recipient: '02aa',
      messageBox: PAYMENT_CONTROL_BOX,
      body: JSON.stringify({ type: 'resend_request', txid: 'aa', reason: 'uncreditible' })
    })
  })
})
