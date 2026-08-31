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
