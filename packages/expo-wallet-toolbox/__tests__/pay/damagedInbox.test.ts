import { isPaymentTokenShape, listDamagedInboxMessages } from '../../core/pay/damagedInbox'
import { limitsForTier } from '../../core/services/walletArgLimits'

const LIMITS = limitsForTier('mid')

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

  // XR-047: an unbounded transaction/derivation field is re-shape-checked on
  // every poll forever (nothing here ever removes a poisoned message from the
  // box), so a huge array must be rejected up front rather than paying for a
  // full .every() scan on every pass.
  it('XR-047: rejects a transaction array over the internalizeTx byte ceiling, before scanning it', () => {
    const oversized = new Array(LIMITS.internalizeTx + 1).fill(0)
    expect(
      isPaymentTokenShape({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: oversized,
        amount: 3
      })
    ).toBe(false)
  })

  it('XR-047: still accepts a transaction array right at the ceiling', () => {
    const atLimit = new Array(LIMITS.internalizeTx).fill(0)
    expect(
      isPaymentTokenShape({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: atLimit,
        amount: 3
      })
    ).toBe(true)
  })

  it('XR-047: rejects an oversized derivation string', () => {
    const hugePrefix = 'a'.repeat(LIMITS.customInstructions + 1)
    expect(
      isPaymentTokenShape({
        customInstructions: { derivationPrefix: hugePrefix, derivationSuffix: 's' },
        transaction: [1, 2],
        amount: 3
      })
    ).toBe(false)
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
