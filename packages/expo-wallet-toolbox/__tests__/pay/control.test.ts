import { PAYMENT_CONTROL_BOX, parseControlMessage, sendControlMessage,
  isDuplicateMessageError
} from '../../core/peerpay/control'

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
    expect(sendMessage).toHaveBeenCalledWith(
      {
        recipient: '02aa',
        messageBox: PAYMENT_CONTROL_BOX,
        body: JSON.stringify({ type: 'resend_request', txid: 'aa', reason: 'uncreditible' })
      },
      undefined // no override: the box is resolved for the recipient as before
    )
  })

  it('posts to an overridden host when the caller names one', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    await sendControlMessage(
      { sendMessage },
      { recipient: '02aa', message: { type: 'payment_cancelled', txid: 'aa' } },
      'https://their.box'
    )
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageBox: PAYMENT_CONTROL_BOX, recipient: '02aa' }),
      'https://their.box'
    )
  })
})

// The box keys a message by an HMAC of its body against the recipient, so
// re-delivering an unchanged token collides with the copy already there.
describe('isDuplicateMessageError', () => {
  it('recognises the box refusing a message it already holds', () => {
    expect(
      isDuplicateMessageError(new Error('Message sending failed: HTTP 400 - Message already exists'))
    ).toBe(true)
    expect(
      isDuplicateMessageError(new Error('Message sending failed: HTTP 400 - ERR_DUPLICATE_MESSAGE duplicate'))
    ).toBe(true)
  })

  it('leaves any other 400 as the failure it is', () => {
    expect(isDuplicateMessageError(new Error('Message sending failed: HTTP 400 - body too large'))).toBe(false)
    // A bare 400 says nothing about why, so it must not be read as delivered.
    expect(isDuplicateMessageError(new Error('Message sending failed: HTTP 400 - 400'))).toBe(false)
  })

  it('does not swallow other statuses or plain network failures', () => {
    expect(isDuplicateMessageError(new Error('HTTP 500 - duplicate'))).toBe(false)
    expect(isDuplicateMessageError(new Error('Network request failed'))).toBe(false)
    expect(isDuplicateMessageError(undefined)).toBe(false)
  })
})
