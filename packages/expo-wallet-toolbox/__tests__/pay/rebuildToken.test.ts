import { instructionsFromOutput, rebuildPeerPayToken } from '../../core/peerpay/rebuildToken'

describe('instructionsFromOutput', () => {
  it('reads the JSON the send path writes', () => {
    expect(
      instructionsFromOutput(JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's', type: 'BRC29' }))
    ).toEqual({ derivationPrefix: 'p', derivationSuffix: 's' })
  })
})

describe('rebuildPeerPayToken', () => {
  it('rebuilds a token with a fresh AtomicBEEF', async () => {
    const beef = [9, 9, 9]
    const result = await rebuildPeerPayToken({
      action: {
        txid: 'aa',
        outputs: [{ customInstructions: JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's', type: 'BRC29' }) }]
      },
      recipient: '02aa',
      refetch: async () => beef
    })
    expect(result?.token.transaction).toEqual(beef)
    expect(result?.token.customInstructions).toEqual({ derivationPrefix: 'p', derivationSuffix: 's' })
    expect(result?.recipient).toBe('02aa')
  })

  it('returns undefined when the beef cannot be refetched', async () => {
    const result = await rebuildPeerPayToken({
      action: { txid: 'aa', outputs: [{ customInstructions: JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's' }) }] },
      recipient: '02aa',
      refetch: async () => undefined
    })
    expect(result).toBeUndefined()
  })
})

// Change outputs carry derivation data too. Rebuilding from the first output
// that has any would describe the sender's own change: wrong amount, and keys
// the recipient cannot derive.
describe('choosing the output that paid the recipient', () => {
  const action = {
    txid: 'aa',
    outputs: [
      {
        customInstructions: JSON.stringify({ derivationPrefix: 'chg', derivationSuffix: 'chg' }),
        satoshis: 4242,
        outputIndex: 1,
        basket: 'default'
      },
      {
        customInstructions: JSON.stringify({ derivationPrefix: 'pay', derivationSuffix: 'pay' }),
        satoshis: 777,
        outputIndex: 0,
        basket: ''
      }
    ]
  }

  it('skips wallet change and takes the output paying someone else', async () => {
    const r = await rebuildPeerPayToken({ action, recipient: '02'.padEnd(66, 'a'), refetch: async () => [1] })
    expect(r!.token.customInstructions).toEqual({ derivationPrefix: 'pay', derivationSuffix: 'pay' })
    expect(r!.token.amount).toBe(777)
    expect(r!.token.outputIndex).toBe(0)
  })

  it('falls back to the first output with derivation data when nothing is basketed', async () => {
    const unmarked = { txid: 'aa', outputs: [{ customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, satoshis: 5 }] }
    const r = await rebuildPeerPayToken({ action: unmarked, recipient: '02'.padEnd(66, 'a'), refetch: async () => [1] })
    expect(r!.token.customInstructions).toEqual({ derivationPrefix: 'p', derivationSuffix: 's' })
  })
})
