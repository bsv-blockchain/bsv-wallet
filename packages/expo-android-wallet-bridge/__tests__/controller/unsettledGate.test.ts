import { createBindingLedger } from '../../src/controller/bindingLedger'
import { createTokenOutbox } from '../../src/controller/tokenOutbox'
import { createUnsettledGate } from '../../src/controller/unsettledGate'

const A = 'https://a.example'

describe('unsettled gate', () => {
  it('second same-origin connect refused before the proof is burnt', () => {
    const gate = createUnsettledGate()
    expect(gate.check(A)).toBe(true)
    gate.claim(A, 'e1')
    // The router calls check() before launches.take(), so a refused second connect never touches a launch record.
    expect(gate.check(A)).toBe(false)
    expect(gate.check('https://b.example')).toBe(true)
    gate.release('e1')
    expect(gate.check(A)).toBe(true)
  })

  it('two bindings parked through a core fake: only the owner receives the token', () => {
    const gate = createUnsettledGate()
    const outbox = createTokenOutbox()
    gate.claim(A, 'owner')
    // A second binding of the same origin that somehow exists (the gate is belt and braces for the core's loop).
    const parkedBindings = [
      { epoch: 'owner', origin: A },
      { epoch: 'intruder', origin: A }
    ]
    // The core fake: on Approve it calls deliverReconnectToken for every parked live unattested binding of the origin.
    const deliver = (b: { epoch: string; origin: string }, token: string) => {
      if (gate.isOwner(b.origin, b.epoch)) outbox.put(b.epoch, token)
    }
    for (const b of parkedBindings) deliver(b, 'the-token')
    expect(outbox.take('owner')).toBe('the-token')
    expect(outbox.take('intruder')).toBeUndefined()
  })

  it('abandoned parked connect closes disconnected and withdraws consent', () => {
    const consent = new Set(['e1'])
    const closed: [string, string][] = []
    const ledger = createBindingLedger(() => 0)
    const gate = createUnsettledGate({
      closeDisconnected(epoch) {
        closed.push([epoch, 'disconnected'])
        consent.delete(epoch) // the core removes the consent request when its binding closes
        ledger.close(epoch)
      }
    })
    ledger.open('e1', A, new Uint8Array(32))
    gate.claim(A, 'e1')
    expect(gate.abandon('e1')).toBe(true)
    expect(closed).toEqual([['e1', 'disconnected']])
    expect(consent.size).toBe(0)
    expect(gate.check(A)).toBe(true)
    // Not an owner any more: nothing to do twice.
    expect(gate.abandon('e1')).toBe(false)
    expect(closed).toHaveLength(1)
  })
})
