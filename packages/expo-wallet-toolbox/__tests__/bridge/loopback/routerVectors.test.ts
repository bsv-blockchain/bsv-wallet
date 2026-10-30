/**
 * BRC-185 published vectors through the loopback router. The fixture's descriptor advertises an `http-wire`
 * endpoint, which loopback never does, so the router's own describe body cannot match the fixture byte for byte.
 * What carries over is the identity: the fixture's seed signs through the router's identity handle, the signing
 * path reproduces the published signature, and the router's describe and connect proofs verify under the
 * fixture's key for the fixture's origin and challenge.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uDecode, b64uEncode } from '../../../core/bridge/protocol/base64url'
import type { ContinuityHandle } from '../../../core/bridge/protocol/continuity'
import { describePreimage, verifyConnectProof, verifyDescribeProof } from '../../../core/bridge/protocol/descriptor'
import { launchProof } from '../../../core/bridge/loopback/launchProof'
import vectors from '../fixtures/0185-vectors.json'
import { EPOCH, HELLO_KEY, HOST4, NONCE, done, makeHarness } from './helpers/routerHarness'

const V = vectors.descriptorProof
const seed = new Uint8Array(Buffer.from(V.seedHex, 'hex'))
const identity: ContinuityHandle = {
  instanceId: V.input.descriptor.instanceId,
  continuityKey: b64uEncode(ed25519.getPublicKey(seed)),
  sign: async preimage => ed25519.sign(preimage, seed)
}
const ORIGIN = V.input.origin
const CHALLENGE = V.input.challenge

describe('loopback router over the BRC-185 vectors', () => {
  it('the identity handle reproduces the published descriptor signature', async () => {
    expect(identity.continuityKey).toBe(V.input.descriptor.continuityKey)
    const sig = await identity.sign(describePreimage(V.input))
    expect(b64uEncode(sig)).toBe(V.signatureBase64url)
  })

  it('describe through the router verifies under the vector key, origin and challenge', async () => {
    const h = makeHarness({ identity })
    const r = done(
      await h.handle({
        target: `/.well-known/brc-wallet?challenge=${CHALLENGE}`,
        headers: [
          ['host', HOST4],
          ['origin', ORIGIN]
        ]
      })
    )
    expect(r.status).toBe(200)
    const descriptor = verifyDescribeProof(JSON.parse(r.body), { origin: ORIGIN, challenge: CHALLENGE })
    expect(descriptor.continuityKey).toBe(V.input.descriptor.continuityKey)
    expect(descriptor.endpoints.map(e => e.type)).toEqual(['http-json', 'http-json', 'http-json'])
    // the same body does not verify for another origin or challenge
    expect(() =>
      verifyDescribeProof(JSON.parse(r.body), { origin: 'https://other.example', challenge: CHALLENGE })
    ).toThrow()
    expect(() =>
      verifyDescribeProof(JSON.parse(r.body), { origin: ORIGIN, challenge: b64uEncode(new Uint8Array(32)) })
    ).toThrow()
  })

  it('a connect proof through the router verifies under the vector key', async () => {
    const h = makeHarness({ identity, realRegistry: true })
    await h.ready
    h.state.records = [{ epoch: EPOCH, k: HELLO_KEY, n: NONCE }]
    h.state.snapshot = { accountContext: 'acct-1', walletRevision: '1' }
    const wallet = { instanceId: identity.instanceId, continuityKey: identity.continuityKey }
    const r = done(
      await h.handle({
        method: 'POST',
        target: '/.well-known/brc-wallet/connect',
        headers: [
          ['host', HOST4],
          ['origin', ORIGIN],
          ['content-type', 'application/json']
        ],
        body: JSON.stringify({
          epoch: EPOCH,
          challenge: CHALLENGE,
          ...wallet,
          android: {
            launchProof: launchProof(HELLO_KEY, {
              wallet,
              epoch: EPOCH,
              origin: ORIGIN,
              challenge: CHALLENGE,
              host: HOST4,
              nonce: NONCE
            })
          }
        })
      })
    )
    expect(r.status).toBe(200)
    const descriptor = verifyConnectProof(JSON.parse(r.body), {
      origin: ORIGIN,
      epoch: EPOCH,
      challenge: CHALLENGE,
      expectedIdentity: { instanceId: identity.instanceId, continuityKey: identity.continuityKey }
    })
    expect(descriptor.continuityKey).toBe(V.input.descriptor.continuityKey)
    expect(b64uDecode(JSON.parse(r.body).signature)).toHaveLength(64)
  })
})
