import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uDecode, b64uEncode } from '../../../core/bridge/protocol/base64url'
import {
  connectPreimage,
  Descriptor,
  describePreimage,
  isStrongEd25519Key,
  isValidIconReference,
  ProofError,
  signConnect,
  signDescribe,
  validateDescriptor,
  verifyConnectProof,
  verifyDescribeProof,
  DescriptorError
} from '../../../core/bridge/protocol/descriptor'
import vectors from '../fixtures/0185-vectors.json'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'))

const V = vectors.descriptorProof
const seed = fromHex(V.seedHex)
const pub = ed25519.getPublicKey(seed)
const signer = { sign: async (m: Uint8Array) => ed25519.sign(m, seed) }

const ORIGIN = 'https://app.example'
const CHALLENGE = b64uEncode(new Uint8Array(32).map((_, i) => i))
const EPOCH = '22222222-2222-4222-8222-222222222222'

function baseDescriptor(over: Record<string, unknown> = {}): Descriptor {
  return {
    version: 1,
    instanceId: '11111111-1111-4111-8111-111111111111',
    name: 'Example Wallet',
    instanceLabel: '',
    vendor: 'example.wallet',
    continuityKey: b64uEncode(pub),
    endpoints: [{ id: 'wire', type: 'http-wire', address: 'http://localhost:3302' }],
    ...over
  } as Descriptor
}

describe('BRC-185 published vectors', () => {
  it('the vector public key matches the seed', () => {
    expect(hex(pub)).toBe(V.publicKeyHex)
  })

  it('reproduces the preimage and signature verbatim', async () => {
    const pre = describePreimage(V.input)
    expect(hex(pre)).toBe(V.preimageHex)
    expect(Buffer.from(pre).toString('utf8')).toBe('BRC-185 descriptor v1\n' + V.jcsUtf8)
    const sig = await signer.sign(pre)
    expect(b64uEncode(sig)).toBe(V.signatureBase64url)
  })

  it('verifies the published signature', () => {
    const d = verifyDescribeProof(
      { descriptor: V.input.descriptor, challenge: V.input.challenge, signature: V.signatureBase64url },
      { origin: V.input.origin, challenge: V.input.challenge }
    )
    expect(d.name).toBe('Example Wallet')
    expect(d.endpoints[0].address).toBe('http://localhost:3302')
  })

  it('verifies when given the raw JSON text', () => {
    const text = JSON.stringify({
      descriptor: V.input.descriptor,
      challenge: V.input.challenge,
      signature: V.signatureBase64url
    })
    expect(() => verifyDescribeProof(text, { origin: V.input.origin, challenge: V.input.challenge })).not.toThrow()
  })
})

describe('describe proofs', () => {
  const okResp = () => signDescribe(signer, { origin: ORIGIN, challenge: CHALLENGE, descriptor: baseDescriptor() })

  it('round-trips', async () => {
    const d = verifyDescribeProof(await okResp(), { origin: ORIGIN, challenge: CHALLENGE })
    expect(d.instanceId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('rejects a tampered signature', async () => {
    const r = await okResp()
    const sig = b64uDecode(r.signature)
    sig[5] ^= 1
    expect(() =>
      verifyDescribeProof({ ...r, signature: b64uEncode(sig) }, { origin: ORIGIN, challenge: CHALLENGE })
    ).toThrow(ProofError)
  })

  it('rejects a tampered descriptor', async () => {
    const r = await okResp()
    expect(() =>
      verifyDescribeProof(
        { ...r, descriptor: { ...r.descriptor, name: 'Evil' } },
        { origin: ORIGIN, challenge: CHALLENGE }
      )
    ).toThrow(/does not verify/)
  })

  it('rejects the wrong challenge', async () => {
    const r = await okResp()
    const other = b64uEncode(new Uint8Array(32).fill(9))
    expect(() => verifyDescribeProof(r, { origin: ORIGIN, challenge: other })).toThrow(/echoed/)
  })

  it('rejects a response signed for another origin', async () => {
    const r = await okResp()
    expect(() => verifyDescribeProof(r, { origin: 'https://other.example', challenge: CHALLENGE })).toThrow(
      /does not verify/
    )
  })

  it('rejects a short or non-canonical expected challenge', async () => {
    const r = await okResp()
    expect(() => verifyDescribeProof(r, { origin: ORIGIN, challenge: 'AAAA' })).toThrow(ProofError)
  })

  it('rejects small-order continuity keys even with a matching signature', async () => {
    const identity = new Uint8Array(32)
    identity[0] = 1 // the identity point: order 1
    const zeroSig = b64uEncode(new Uint8Array(64))
    const d = baseDescriptor({ continuityKey: b64uEncode(identity) })
    expect(() =>
      verifyDescribeProof(
        { descriptor: d, challenge: CHALLENGE, signature: zeroSig },
        { origin: ORIGIN, challenge: CHALLENGE }
      )
    ).toThrow(/does not verify/)
    // Order-8 point (0 , -1 is order 2; this encodes y = 0 which has order 4)
    const order4 = new Uint8Array(32)
    const d2 = baseDescriptor({ continuityKey: b64uEncode(order4) })
    expect(() =>
      verifyDescribeProof(
        { descriptor: d2, challenge: CHALLENGE, signature: zeroSig },
        { origin: ORIGIN, challenge: CHALLENGE }
      )
    ).toThrow(/does not verify/)
  })

  it('rejects an oversized response', async () => {
    const r = await okResp()
    const big = { ...r, padding: 'x'.repeat(17000) }
    expect(() => verifyDescribeProof(big, { origin: ORIGIN, challenge: CHALLENGE })).toThrow(/too large/)
    expect(() => verifyDescribeProof(JSON.stringify(big), { origin: ORIGIN, challenge: CHALLENGE })).toThrow(
      /too large/
    )
  })

  it('rejects unknown or missing response fields', async () => {
    const r = await okResp()
    expect(() => verifyDescribeProof({ ...r, extra: 1 }, { origin: ORIGIN, challenge: CHALLENGE })).toThrow(
      /unknown response field/
    )
    const { signature: _s, ...noSig } = r
    expect(() => verifyDescribeProof(noSig, { origin: ORIGIN, challenge: CHALLENGE })).toThrow(/missing/)
  })

  it('rejects duplicate keys in raw response text', async () => {
    const r = await okResp()
    // A second "challenge" key at the front of the object.
    const text = '{"challenge":"x",' + JSON.stringify(r).slice(1)
    expect(() => verifyDescribeProof(text, { origin: ORIGIN, challenge: CHALLENGE })).toThrow(/strict JSON/)
  })

  it('rejects an unknown descriptor field and a null optional field', async () => {
    for (const extra of [{ extra: 1 }, { icon: null }]) {
      const d = baseDescriptor(extra)
      const r = await signDescribe(signer, { origin: ORIGIN, challenge: CHALLENGE, descriptor: d })
      expect(() => verifyDescribeProof(r, { origin: ORIGIN, challenge: CHALLENGE })).toThrow(ProofError)
    }
  })

  it('treats an invalid icon as absent while the signature still verifies', async () => {
    const d = baseDescriptor({ icon: 'http://insecure.example/i.png' })
    const r = await signDescribe(signer, { origin: ORIGIN, challenge: CHALLENGE, descriptor: d })
    const out = verifyDescribeProof(r, { origin: ORIGIN, challenge: CHALLENGE })
    expect(out.icon).toBeUndefined()
  })

  it('keeps a valid icon', async () => {
    const d = baseDescriptor({ icon: 'https://wallet.example/icon.png' })
    const r = await signDescribe(signer, { origin: ORIGIN, challenge: CHALLENGE, descriptor: d })
    expect(verifyDescribeProof(r, { origin: ORIGIN, challenge: CHALLENGE }).icon).toBe(
      'https://wallet.example/icon.png'
    )
  })
})

describe('isStrongEd25519Key', () => {
  it('accepts a real key and refuses small-order, non-canonical and malformed keys', () => {
    expect(isStrongEd25519Key(pub)).toBe(true)
    const identity = new Uint8Array(32)
    identity[0] = 1
    expect(isStrongEd25519Key(identity)).toBe(false) // order 1
    expect(isStrongEd25519Key(new Uint8Array(32))).toBe(false) // y = 0, order 4
    const order2 = new Uint8Array(32)
    order2[0] = 0xec
    order2.fill(0xff, 1, 31)
    order2[31] = 0x7f // y = -1, order 2
    expect(isStrongEd25519Key(order2)).toBe(false)
    const nonCanonical = new Uint8Array(32).fill(0xff) // y >= p
    nonCanonical[31] = 0x7f
    expect(isStrongEd25519Key(nonCanonical)).toBe(false)
    expect(isStrongEd25519Key(new Uint8Array(31))).toBe(false)
  })
})

describe('connect proofs', () => {
  const identity = { instanceId: '11111111-1111-4111-8111-111111111111', continuityKey: b64uEncode(pub) }
  const ctx = { origin: ORIGIN, epoch: EPOCH, challenge: CHALLENGE, expectedIdentity: identity }
  const make = () =>
    signConnect(signer, { origin: ORIGIN, epoch: EPOCH, challenge: CHALLENGE, descriptor: baseDescriptor() })

  it('uses a distinct domain-separation prefix', () => {
    const a = describePreimage({ origin: ORIGIN, challenge: CHALLENGE, descriptor: baseDescriptor() })
    const b = connectPreimage({ origin: ORIGIN, epoch: EPOCH, challenge: CHALLENGE, descriptor: baseDescriptor() })
    expect(Buffer.from(b).toString().startsWith('BRC-185 connect v1\n{"challenge"')).toBe(true)
    expect(hex(a)).not.toBe(hex(b))
  })

  it('round-trips', async () => {
    expect(verifyConnectProof(await make(), ctx).name).toBe('Example Wallet')
  })

  it('a describe proof is not a connect proof', async () => {
    const r = await signDescribe(signer, { origin: ORIGIN, challenge: CHALLENGE, descriptor: baseDescriptor() })
    expect(() => verifyConnectProof({ ...r, epoch: EPOCH }, ctx)).toThrow(/does not verify/)
  })

  it('rejects a different epoch, challenge, instance or key', async () => {
    const r = await make()
    expect(() => verifyConnectProof(r, { ...ctx, epoch: '33333333-3333-4333-8333-333333333333' })).toThrow(/epoch/)
    expect(() => verifyConnectProof(r, { ...ctx, challenge: b64uEncode(new Uint8Array(32).fill(1)) })).toThrow(/echoed/)
    expect(() =>
      verifyConnectProof(r, {
        ...ctx,
        expectedIdentity: { ...identity, instanceId: '44444444-4444-4444-8444-444444444444' }
      })
    ).toThrow(/different provider/)
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(7))
    expect(() =>
      verifyConnectProof(r, { ...ctx, expectedIdentity: { ...identity, continuityKey: b64uEncode(otherPub) } })
    ).toThrow(/different provider/)
  })
})

describe('validateDescriptor', () => {
  const bad = (over: Record<string, unknown>) => () => validateDescriptor(baseDescriptor(over))

  it('accepts a minimal descriptor', () => {
    expect(validateDescriptor(baseDescriptor())).toEqual(baseDescriptor())
  })

  it('checks version, ids and names', () => {
    expect(bad({ version: 2 })).toThrow(DescriptorError)
    expect(bad({ instanceId: '11111111-1111-4111-8111-11111111111A' })).toThrow(DescriptorError)
    expect(bad({ instanceId: '11111111-1111-1111-8111-111111111111' })).toThrow(DescriptorError)
    expect(bad({ name: '' })).toThrow(DescriptorError)
    expect(bad({ name: 'x'.repeat(81) })).toThrow(DescriptorError)
    expect(bad({ name: 'é'.repeat(41) })).toThrow(DescriptorError) // 82 bytes
    expect(bad({ name: 'é'.repeat(40) })).not.toThrow() // 80 bytes
    expect(bad({ instanceLabel: 'x'.repeat(81) })).toThrow(DescriptorError)
    expect(bad({ name: 'a\u202eb' })).toThrow(DescriptorError)
    expect(bad({ name: 'a\nb' })).toThrow(DescriptorError)
    expect(bad({ name: 'a\ud800' })).toThrow(DescriptorError)
  })

  it('checks vendor', () => {
    for (const v of ['Example.Wallet', 'wallet', '', '.example', 'example..wallet', 'ex ample.wallet', 'é.wallet']) {
      expect(bad({ vendor: v })).toThrow(DescriptorError)
    }
    expect(bad({ vendor: 'org.bsvblockchain.wallet' })).not.toThrow()
  })

  it('checks the continuity key', () => {
    expect(bad({ continuityKey: 'AAAA' })).toThrow(DescriptorError)
    expect(bad({ continuityKey: b64uEncode(pub) + '=' })).toThrow(DescriptorError)
    expect(bad({ continuityKey: b64uEncode(pub).slice(0, 42) + 'B' })).toThrow(DescriptorError)
  })

  it('checks endpoints', () => {
    const ep = (e: Record<string, unknown>) => ({
      endpoints: [{ id: 'a', type: 'http-wire', address: 'http://localhost:3301', ...e }]
    })
    expect(bad({ endpoints: [] })).toThrow(DescriptorError)
    expect(
      bad({ endpoints: Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, type: 'window', address: 'x' })) })
    ).toThrow(DescriptorError)
    expect(
      bad({ endpoints: Array.from({ length: 32 }, (_, i) => ({ id: `e${i}`, type: 'window', address: 'x' })) })
    ).not.toThrow()
    expect(bad({ endpoints: [ep({}).endpoints[0], ep({}).endpoints[0]] })).toThrow(/unique/)
    expect(bad(ep({ id: 'has space' }))).toThrow(DescriptorError)
    expect(bad(ep({ id: 'x'.repeat(65) }))).toThrow(DescriptorError)
    expect(bad(ep({ extra: 1 }))).toThrow(DescriptorError)
    expect(bad(ep({ address: '' }))).toThrow(DescriptorError)
    expect(bad(ep({ type: 'carrier-pigeon' }))).toThrow(DescriptorError)
    expect(bad(ep({ type: 'https://spec.example/ext', address: 'opaque-handle' }))).not.toThrow()
    expect(bad(ep({ type: 'http://spec.example/ext' }))).toThrow(DescriptorError)
    for (const t of ['window', 'xdm', 'react-native']) expect(bad(ep({ type: t, address: 'handle-1' }))).not.toThrow()
    expect(bad(ep({ type: 'window', address: 'x'.repeat(2049) }))).toThrow(DescriptorError)
  })

  it('requires loopback origins for HTTP endpoints', () => {
    for (const a of ['http://localhost:3301', 'http://127.0.0.1:3321', 'http://[::1]:8080', 'http://localhost']) {
      expect(() =>
        validateDescriptor(baseDescriptor({ endpoints: [{ id: 'a', type: 'http-json', address: a }] }))
      ).not.toThrow()
    }
    for (const a of [
      'http://example.com:3301',
      'http://localhost:3301/',
      'http://localhost:3301/x',
      'http://localhost:0',
      'http://localhost:65536',
      'http://localhost:03301',
      'https://localhost:3301',
      'http://user@localhost:3301',
      'http://localhost.evil.com:3301',
      'http://LOCALHOST:3301',
      'http://0.0.0.0:3301'
    ]) {
      expect(() =>
        validateDescriptor(baseDescriptor({ endpoints: [{ id: 'a', type: 'http-wire', address: a }] }))
      ).toThrow(DescriptorError)
    }
  })

  it('requires https origins for https-json', () => {
    const mk = (address: string) => baseDescriptor({ endpoints: [{ id: 'a', type: 'https-json', address }] })
    expect(() => validateDescriptor(mk('https://localhost:2121'))).not.toThrow()
    expect(() => validateDescriptor(mk('https://wallet.example'))).not.toThrow()
    expect(() => validateDescriptor(mk('http://localhost:2121'))).toThrow(DescriptorError)
    expect(() => validateDescriptor(mk('https://wallet.example/path'))).toThrow(DescriptorError)
  })

  it('rejects non-objects and non-string icons', () => {
    expect(() => validateDescriptor(null)).toThrow(DescriptorError)
    expect(() => validateDescriptor([])).toThrow(DescriptorError)
    expect(bad({ icon: 5 })).toThrow(DescriptorError)
  })
})

describe('isValidIconReference', () => {
  // Base58Check(ce00 || sha256("x")) built with the same primitive the validator uses.
  const uhrp = (): string => {
    const { Utils, Hash } = require('@bsv/sdk')
    return 'uhrp://' + Utils.toBase58Check(Hash.sha256([120]), [0xce, 0x00])
  }

  it('accepts the three forms', () => {
    expect(isValidIconReference('https://wallet.example/icon.png')).toBe(true)
    expect(isValidIconReference('https://wallet.example:8443/a/b?c=D')).toBe(true)
    expect(isValidIconReference(uhrp())).toBe(true)
    expect(isValidIconReference('chirp://AbC123')).toBe(true)
  })

  it('rejects everything else', () => {
    for (const r of [
      '',
      'http://wallet.example/icon.png',
      'data:image/png;base64,AAAA',
      'https://user:pw@wallet.example/i.png',
      'https://wallet.example/i.png#frag',
      'https://wallet.example',
      'HTTPS://wallet.example/i.png',
      'https://Wallet.example/i.png',
      'https://wallet.example/' + 'a'.repeat(260),
      'uhrp://notbase58check',
      'uhrp://' + uhrp().slice(7, -1) + (uhrp().endsWith('1') ? '2' : '1'),
      'uhrp:///',
      'chirp://',
      'chirp://has space',
      'ftp://x/y'
    ]) {
      expect(isValidIconReference(r)).toBe(false)
    }
  })

  it('rejects a UHRP reference with the wrong prefix', () => {
    const { Utils, Hash } = require('@bsv/sdk')
    expect(isValidIconReference('uhrp://' + Utils.toBase58Check(Hash.sha256([120]), [0xce, 0x01]))).toBe(false)
    expect(isValidIconReference('uhrp://' + Utils.toBase58Check(Hash.sha256([120]).slice(1), [0xce, 0x00]))).toBe(false)
  })
})
