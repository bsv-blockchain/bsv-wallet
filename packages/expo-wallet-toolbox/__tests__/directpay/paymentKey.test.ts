import { paymentKey } from '../../core/directpay'

describe('paymentKey', () => {
  const txid = 'ab'.repeat(32)

  // The format is shared with BSV Desktop and @bsv/webrtpay's `paymentKey`: a peer's
  // `seen` store and the message box dedupe both hold it, so it must never drift.
  it('is txid:outputIndex:derivationPrefix:derivationSuffix', () => {
    expect(paymentKey(txid, 0, 'cHJlZml4', 'c3VmZml4')).toBe(`${txid}:0:cHJlZml4:c3VmZml4`)
    expect(paymentKey('00ff', 7, 'a+/=', 'b+/=')).toBe('00ff:7:a+/=:b+/=')
  })

  it('splits back into its four parts on ":"', () => {
    expect(paymentKey(txid, 3, 'cHJlZml4', 'c3VmZml4').split(':')).toEqual([txid, '3', 'cHJlZml4', 'c3VmZml4'])
  })

  it('differs when any part differs', () => {
    const base = paymentKey(txid, 0, 'p', 's')
    expect(paymentKey('cd'.repeat(32), 0, 'p', 's')).not.toBe(base)
    expect(paymentKey(txid, 1, 'p', 's')).not.toBe(base)
    expect(paymentKey(txid, 0, 'q', 's')).not.toBe(base)
    expect(paymentKey(txid, 0, 'p', 't')).not.toBe(base)
  })

  it('is the same for the same payment however it arrived', () => {
    expect(paymentKey(txid, 0, 'p', 's')).toBe(paymentKey(txid, 0, 'p', 's'))
  })
})
