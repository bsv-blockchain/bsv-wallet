import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { satoshisFromToken } from '../../core/pay/tokenAmount'

function tokenWithOutput(satoshis: number, claimed?: number) {
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(new PrivateKey(1).toPublicKey().toAddress()) })
  return {
    transaction: tx.toAtomicBEEF(),
    outputIndex: 0,
    amount: claimed ?? satoshis
  }
}

describe('satoshisFromToken', () => {
  it('reads satoshis from the output, not the JSON claim', () => {
    const r = satoshisFromToken(tokenWithOutput(1, 50000))
    expect(r?.satoshis).toBe(1)
    expect(r?.claimedAgrees).toBe(false)
  })

  it('agrees when the claim matches the output', () => {
    const r = satoshisFromToken(tokenWithOutput(700, 700))
    expect(r?.satoshis).toBe(700)
    expect(r?.claimedAgrees).toBe(true)
  })

  it('returns undefined when the bytes will not parse', () => {
    expect(satoshisFromToken({ transaction: [1, 2, 3], amount: 500 })).toBeUndefined()
  })
})
