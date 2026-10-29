import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uEncode } from '../../../core/bridge/protocol/base64url'
import { loopbackEndpoints } from '../../../core/bridge/loopback/endpoints'
import { validateDescriptor } from '../../../core/bridge/protocol/descriptor'

describe('loopback endpoints', () => {
  it('list every bound spelling and is stable across calls', () => {
    const b = { port: 3330, ipv4: true, ipv6: true }
    const a = loopbackEndpoints(b)
    expect(a).toEqual([
      { id: 'json-ipv4', type: 'http-json', address: 'http://127.0.0.1:3330' },
      { id: 'json-ipv6', type: 'http-json', address: 'http://[::1]:3330' },
      { id: 'json-localhost', type: 'http-json', address: 'http://localhost:3330' }
    ])
    expect(loopbackEndpoints({ ...b })).toEqual(a)
  })

  it('advertises localhost and ipv6 only when bound', () => {
    expect(loopbackEndpoints({ port: 3321, ipv4: true, ipv6: false }).map(e => e.id)).toEqual(['json-ipv4'])
  })

  it('every address passes descriptor endpoint validation', () => {
    const eps = loopbackEndpoints({ port: 3321, ipv4: true, ipv6: true })
    const d = validateDescriptor({
      version: 1,
      instanceId: '11111111-1111-4111-8111-111111111111',
      name: 'W',
      instanceLabel: 'W',
      vendor: 'org.example.wallet',
      continuityKey: b64uEncode(ed25519.getPublicKey(new Uint8Array(32).fill(7))),
      endpoints: eps
    } as unknown)
    expect(d.endpoints).toEqual(eps)
  })
})
