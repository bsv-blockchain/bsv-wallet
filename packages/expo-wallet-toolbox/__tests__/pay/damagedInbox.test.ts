import { isPaymentTokenShape, listDamagedInboxMessages } from '../../core/pay/damagedInbox'

describe('isPaymentTokenShape', () => {
  it('accepts a token-shaped body', () => {
    expect(
      isPaymentTokenShape({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1, 2],
        amount: 3
      })
    ).toBe(true)
  })

  it('rejects JSON that is not a token', () => {
    expect(isPaymentTokenShape({ hello: 'world' })).toBe(false)
    expect(isPaymentTokenShape(null)).toBe(false)
  })
})

describe('listDamagedInboxMessages', () => {
  it('returns raw ids that did not parse into tokens', () => {
    const damaged = listDamagedInboxMessages({
      raw: [
        { messageId: 'good', sender: '02aa', body: '{}' },
        { messageId: 'bad', sender: '02bb', body: '[Error: Failed to decrypt or parse message]' }
      ],
      parsed: [{ messageId: 'good' }]
    })
    expect(damaged).toEqual([{ messageId: 'bad', sender: '02bb', reason: 'unparseable' }])
  })

  it('marks parseable-JSON-but-wrong-shape as bad_shape when the parsed list still includes them', () => {
    // parsed list is what listIncomingPayments returned (non-null JSON).
    // We still shape-check the body.
    const damaged = listDamagedInboxMessages({
      raw: [{ messageId: 'x', sender: '02aa', body: { foo: 1 } }],
      parsed: [{ messageId: 'x' }]
    })
    expect(damaged[0].reason).toBe('bad_shape')
  })
})
