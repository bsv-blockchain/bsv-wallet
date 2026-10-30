import { ProofError, assertAdvertisesResponder, type Descriptor } from '../../../core/bridge/protocol/descriptor'

const descriptor = (endpoints: Array<{ id: string; type: string; address: string }>): Descriptor => ({
  version: 1,
  instanceId: 'i',
  name: 'n',
  instanceLabel: 'l',
  vendor: 'v',
  continuityKey: 'k',
  endpoints
})

const d = descriptor([
  { id: 'json-ipv4', type: 'http-json', address: 'http://127.0.0.1:3321' },
  { id: 'json-ipv6', type: 'http-json', address: 'http://[::1]:3321' }
])

describe('assertAdvertisesResponder', () => {
  it('matching scheme host and port passes', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.1:3321' })).not.toThrow()
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://[::1]:3321' })).not.toThrow()
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.1:3321/' })).not.toThrow()
  })

  it('scheme mismatch throws', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'https://127.0.0.1:3321' })).toThrow(
      ProofError
    )
  })

  it('host mismatch throws', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.2:3321' })).toThrow(
      ProofError
    )
  })

  it('port mismatch throws', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.1:3322' })).toThrow(
      ProofError
    )
  })

  it('type mismatch throws', () => {
    const other = descriptor([{ id: 'x', type: 'something-else', address: 'http://127.0.0.1:3321' }])
    expect(() => assertAdvertisesResponder(other, { type: 'http-json', address: 'http://127.0.0.1:3321' })).toThrow(
      ProofError
    )
  })

  it('127.0.0.1 does not satisfy localhost', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://localhost:3321' })).toThrow(
      ProofError
    )
    const l = descriptor([{ id: 'json-localhost', type: 'http-json', address: 'http://localhost:3321' }])
    expect(() => assertAdvertisesResponder(l, { type: 'http-json', address: 'http://127.0.0.1:3321' })).toThrow(
      ProofError
    )
  })

  it('path in the responder address is rejected', () => {
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.1:3321/x' })).toThrow(
      ProofError
    )
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'http://127.0.0.1:3321/?a=1' })).toThrow(
      ProofError
    )
  })

  it('an unparseable endpoint address is skipped, an unparseable responder throws', () => {
    const odd = descriptor([
      { id: 'a', type: 'http-json', address: 'not a url' },
      { id: 'b', type: 'http-json', address: 'http://127.0.0.1:3321' }
    ])
    expect(() => assertAdvertisesResponder(odd, { type: 'http-json', address: 'http://127.0.0.1:3321' })).not.toThrow()
    expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: 'nope' })).toThrow(ProofError)
  })
})
