import { resources } from '../../core/i18n/translations'
import { NotSentError, fallbackPrompt, payIdentity } from '../../core/directpay'
import type { DialFailure, DirectPayMessage } from '../../core/directpay'

const english = resources.en.translation as Record<string, string>

/** What the user would read, in English, for a key and its parameters. */
const say = ({ key, params }: DirectPayMessage): string =>
  english[key].replace(/{{(\w+)}}/g, (_, name: string) => (params as Record<string, string>)[name])

const notSent = (failure?: DialFailure) => new NotSentError(`not sent (${failure})`, 'because', failure)

// A live attempt that stopped before any payment was made, for `failure`.
const stopsBeforePaying = (failure?: DialFailure) => jest.fn(async () => Promise.reject(notSent(failure)))

describe('payIdentity: live first', () => {
  it('pays live when the direct route succeeds, and never touches the message box', async () => {
    const direct = jest.fn(async () => ({ ackStatus: 'received' }))
    const messageBox = jest.fn(async () => {})
    expect(await payIdentity({ direct, messageBox, name: 'Alice' })).toEqual({
      kind: 'paid_live',
      ackStatus: 'received'
    })
    expect(direct).toHaveBeenCalledTimes(1)
    expect(messageBox).not.toHaveBeenCalled()
  })

  it('passes the acknowledgement status through', async () => {
    const outcome = await payIdentity({ direct: async () => ({ ackStatus: 'accepted' }), name: 'Alice' })
    expect(outcome).toEqual({ kind: 'paid_live', ackStatus: 'accepted' })
  })
})

describe('payIdentity: the message box fallback', () => {
  it.each<DialFailure>(['offline', 'rejected'])('asks to use the message box when %s', async failure => {
    const messageBox = jest.fn(async () => {})
    const outcome = await payIdentity({ direct: stopsBeforePaying(failure), messageBox, name: 'Alice' })
    expect(outcome).toEqual({ kind: 'ask_fallback', reason: 'offline' })
    // The caller runs it, after the user agrees.
    expect(messageBox).not.toHaveBeenCalled()
  })

  it.each<DialFailure>(['timeout', 'unknown'])(
    'asks to use the message box when the link failed (%s)',
    async failure => {
      const outcome = await payIdentity({
        direct: stopsBeforePaying(failure),
        messageBox: async () => {},
        name: 'Alice'
      })
      expect(outcome).toEqual({ kind: 'ask_fallback', reason: 'link_failed' })
    }
  )

  it.each<[DialFailure, string]>([
    ['offline', 'direct_pay_failed_offline'],
    ['rejected', 'direct_pay_failed_offline'],
    ['timeout', 'direct_pay_failed_link'],
    ['unknown', 'direct_pay_failed_link']
  ])('says so, and nothing was spent, when %s and there is no message box to fall back to', async (failure, key) => {
    expect(await payIdentity({ direct: stopsBeforePaying(failure), name: 'Alice' })).toEqual({
      kind: 'failed',
      spent: 'no',
      key,
      params: { name: 'Alice' }
    })
  })

  it('then delivers through the message box once the caller calls again without `direct`', async () => {
    const messageBox = jest.fn(async () => {})
    expect(await payIdentity({ messageBox, name: 'Alice' })).toEqual({ kind: 'paid_messagebox' })
    expect(messageBox).toHaveBeenCalledTimes(1)
  })

  // The message box route makes the payment before it delivers it, so a failure it does not
  // call a NotSentError may come after the payment was made.
  it('says the payment may have been sent when the message box fails, with its own words for the log', async () => {
    const outcome = await payIdentity({
      messageBox: async () => {
        throw new Error('host is down')
      },
      name: 'Alice'
    })
    expect(outcome).toEqual({
      kind: 'failed',
      spent: 'maybe',
      key: 'direct_pay_failed_maybe_sent',
      params: { name: 'Alice' },
      detail: 'host is down'
    })
  })

  it('says nothing was spent when the message box stops before making the payment', async () => {
    const outcome = await payIdentity({
      messageBox: async () => {
        throw new NotSentError('This request has changed or expired.', 'expired')
      },
      name: 'Alice'
    })
    expect(outcome).toEqual({
      kind: 'failed',
      spent: 'no',
      key: 'direct_pay_failed_not_sent',
      detail: 'expired'
    })
  })

  it('fails with no route at all when neither route is given', async () => {
    expect(await payIdentity({ name: 'Alice' })).toEqual({
      kind: 'failed',
      spent: 'no',
      key: 'direct_pay_failed_no_message_box'
    })
  })
})

describe('payIdentity: failures that must not offer the message box', () => {
  it.each<[DialFailure, string]>([
    ['unavailable', 'direct_pay_failed_network'],
    ['wrong_network', 'direct_pay_failed_wrong_network'],
    ['aborted', 'direct_pay_failed_cancelled']
  ])('%s fails outright, even with a message box', async (failure, key) => {
    const messageBox = jest.fn(async () => {})
    const outcome = await payIdentity({ direct: stopsBeforePaying(failure), messageBox, name: 'Alice' })
    expect(outcome).toMatchObject({ kind: 'failed', spent: 'no', key })
    expect(messageBox).not.toHaveBeenCalled()
  })

  it('names the recipient where the wording needs one', async () => {
    expect(await payIdentity({ direct: stopsBeforePaying('wrong_network'), name: 'Alice' })).toMatchObject({
      params: { name: 'Alice' }
    })
    expect(await payIdentity({ direct: stopsBeforePaying('unavailable'), name: 'Alice' })).not.toHaveProperty('params')
  })

  it('does not ask to fall back for a stop with no dial failure behind it, and says nothing was spent', async () => {
    const outcome = await payIdentity({
      direct: stopsBeforePaying(undefined),
      messageBox: async () => {},
      name: 'Alice'
    })
    expect(outcome).toEqual({ kind: 'failed', spent: 'no', key: 'direct_pay_failed_not_sent', detail: 'because' })
  })

  it('keeps the reason of such a stop for the log, falling back to the error message', async () => {
    const outcome = await payIdentity({
      direct: async () => Promise.reject(new NotSentError('too large to deliver directly')),
      name: 'Alice'
    })
    expect(outcome).toMatchObject({ key: 'direct_pay_failed_not_sent', detail: 'too large to deliver directly' })
  })

  // The live payment was made, and may have been delivered: a second route would build a second
  // transaction. Only a NotSentError says nothing was made.
  describe('once the live payment may have been delivered', () => {
    const lostAck = jest.fn(async () => {
      throw new Error("The recipient's wallet did not confirm the payment before the connection ended.")
    })

    it('never asks to fall back after any other error', async () => {
      const messageBox = jest.fn(async () => {})
      const outcome = await payIdentity({ direct: lostAck, messageBox, name: 'Alice' })
      expect(outcome).toEqual({
        kind: 'failed',
        spent: 'maybe',
        key: 'direct_pay_failed_maybe_sent',
        params: { name: 'Alice' },
        detail: "The recipient's wallet did not confirm the payment before the connection ended."
      })
      expect(messageBox).not.toHaveBeenCalled()
    })

    it('says so in words, so the user does not pay again by hand', async () => {
      const outcome = await payIdentity({ direct: lostAck, name: 'Alice' })
      expect(say(outcome as DirectPayMessage)).toBe(
        'Your payment to Alice may already have been sent. Check Activity before paying again.'
      )
    })

    it.each(['peer_unreachable', 'rejected', 'timeout', 'closed'])(
      'does not read a %s from the live route as "nothing was made"',
      async code => {
        const late = Object.assign(new Error(code), { name: 'WebRTPayError', code })
        const outcome = await payIdentity({
          direct: async () => Promise.reject(late),
          messageBox: async () => {},
          name: 'Alice'
        })
        expect(outcome).toMatchObject({ kind: 'failed', spent: 'maybe' })
      }
    )

    it('fails, rather than asking, for an error with no message or a non-error', async () => {
      for (const thrown of [new Error(''), 'oops', undefined, null]) {
        const outcome = await payIdentity({
          direct: async () => Promise.reject(thrown),
          messageBox: async () => {},
          name: 'Alice'
        })
        expect(outcome).toMatchObject({ kind: 'failed', spent: 'maybe', key: 'direct_pay_failed_maybe_sent' })
      }
    })
  })
})

describe('NotSentError', () => {
  it('is an Error that says why the dial failed', () => {
    const error = new NotSentError('Nothing was spent.', 'timed out', 'timeout')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotSentError')
    expect(error.message).toBe('Nothing was spent.')
    expect(error.detail).toBe('timed out')
    expect(error.failure).toBe('timeout')
  })

  it('needs only a message', () => {
    const error = new NotSentError('Nothing was spent.')
    expect(error.detail).toBe('')
    expect(error.failure).toBeUndefined()
  })
})

describe('fallbackPrompt', () => {
  it('asks the offline question, naming the recipient', () => {
    const prompt = fallbackPrompt('offline', 'Alice')
    expect(prompt).toEqual({ key: 'direct_pay_fallback_offline', params: { name: 'Alice' } })
    expect(say(prompt)).toBe(
      "Alice isn't online right now. Send it to their message box? They'll get it next time they open their wallet."
    )
  })

  it('asks the link-failed question, naming the recipient', () => {
    const prompt = fallbackPrompt('link_failed', 'Alice')
    expect(prompt).toEqual({ key: 'direct_pay_fallback_link_failed', params: { name: 'Alice' } })
    expect(say(prompt)).toBe("Couldn't connect to Alice directly. Send it to their message box instead?")
  })

  it('says in English that nothing was spent when a stop has no dial failure', async () => {
    const outcome = await payIdentity({ direct: stopsBeforePaying(undefined), name: 'Alice' })
    expect(say(outcome as DirectPayMessage)).toBe('The payment could not be sent. Nothing was spent.')
  })

  it('is what the failures without a message box say, in English', async () => {
    const offline = await payIdentity({ direct: stopsBeforePaying('offline'), name: 'Alice' })
    expect(say(offline as DirectPayMessage)).toBe(
      "Alice isn't online right now. Nothing was spent. Connect a message box in Settings to pay people who are offline."
    )
  })
})
