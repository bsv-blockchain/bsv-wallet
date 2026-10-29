import { createBindingLedger } from '../../src/controller/bindingLedger'

describe('binding ledger', () => {
  const setup = () => {
    let t = 1000
    const ledger = createBindingLedger(() => t)
    return { ledger, at: (n: number) => void (t = n) }
  }

  it('idleSince is undefined while anything is parked or in flight and set once both reach 0', () => {
    const { ledger, at } = setup()
    ledger.open('e', 'https://a.example', new Uint8Array(32).fill(1))
    expect(ledger.idleSince('e')).toBe(1000)
    at(2000)
    ledger.inFlight('e', 1)
    expect(ledger.idleSince('e')).toBeUndefined()
    at(3000)
    ledger.parked('e', 1)
    at(4000)
    ledger.inFlight('e', -1)
    expect(ledger.idleSince('e')).toBeUndefined()
    at(5000)
    ledger.parked('e', -1)
    expect(ledger.idleSince('e')).toBe(5000)
    expect(ledger.idleSince('unknown')).toBeUndefined()
  })

  it('touch resets idle', () => {
    const { ledger, at } = setup()
    ledger.open('e', 'https://a.example', new Uint8Array(32))
    at(9000)
    ledger.touch('e')
    expect(ledger.idleSince('e')).toBe(9000)
  })

  it('close wipes the secret and the entry', () => {
    const { ledger } = setup()
    const secret = new Uint8Array(32).fill(9)
    ledger.open('e', 'https://a.example', secret)
    const stored = ledger.secret('e')!
    expect(Array.from(stored)).toEqual(Array.from(new Uint8Array(32).fill(9)))
    // A private copy: wiping the caller's array does not change the stored one, and close zeroes the stored one.
    secret.fill(0)
    expect(stored[0]).toBe(9)
    ledger.close('e')
    expect(Array.from(stored)).toEqual(Array.from(new Uint8Array(32)))
    expect(ledger.secret('e')).toBeUndefined()
    expect(ledger.origin('e')).toBeUndefined()
    expect(ledger.isSettled('e')).toBe(false)
  })

  it("epochsForOrigin lists only that origin's bindings", () => {
    const { ledger } = setup()
    ledger.open('a1', 'https://a.example', new Uint8Array(32))
    ledger.open('a2', 'https://a.example', new Uint8Array(32))
    ledger.open('b1', 'https://b.example', new Uint8Array(32))
    expect(ledger.epochsForOrigin('https://a.example').sort()).toEqual(['a1', 'a2'])
    expect(ledger.epochsForOrigin('https://b.example')).toEqual(['b1'])
    expect(ledger.epochsForOrigin('https://c.example')).toEqual([])
  })

  it('settled starts false and is set by markSettled', () => {
    const { ledger } = setup()
    ledger.open('e', 'https://a.example', new Uint8Array(32))
    expect(ledger.isSettled('e')).toBe(false)
    ledger.markSettled('e')
    expect(ledger.isSettled('e')).toBe(true)
  })

  it('the gone set marks, reads and clears', () => {
    const { ledger } = setup()
    expect(ledger.isGone('c1')).toBe(false)
    ledger.markGone('c1')
    expect(ledger.isGone('c1')).toBe(true)
    ledger.clearGone('c1')
    expect(ledger.isGone('c1')).toBe(false)
  })
})
