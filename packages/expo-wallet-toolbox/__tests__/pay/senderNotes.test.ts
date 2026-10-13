import { withSenderNotes } from '../../core/pay/creditInbox'

const token = { customInstructions: { derivationPrefix: 'a', derivationSuffix: 'b' }, transaction: [1], amount: 10 }

describe('withSenderNotes', () => {
  it('puts the note from the raw message back on the parsed payment', () => {
    const list = [{ messageId: '1', sender: 'k', token }, { messageId: '2', sender: 'k', token }] as never
    const raw = [
      { messageId: '1', body: JSON.stringify({ ...token, note: 'Tea' }) },
      { messageId: '2', body: { ...token } }
    ]
    const out = withSenderNotes(list, raw) as { token: { note?: string } }[]
    expect(out[0].token.note).toBe('Tea')
    expect(out[1].token.note).toBeUndefined()
  })

  it('leaves the list alone when nothing has a note or a body is unreadable', () => {
    const list = [{ messageId: '1', sender: 'k', token }] as never
    expect(withSenderNotes(list, [{ messageId: '1', body: '{nope' }])).toBe(list)
  })
})
