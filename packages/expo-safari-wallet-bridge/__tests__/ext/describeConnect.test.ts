import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import { describePreimage, verifyDescribeProof } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import { isConnectionError } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'
import { ed25519 } from '@noble/curves/ed25519.js'
import vectors from '../../../expo-wallet-toolbox/__tests__/bridge/fixtures/0185-vectors.json'
import type { AttestedFrame } from '../../extension/src/lib/attest'
import { loadBindings } from '../../extension/src/lib/bindings'
import { assertDescribeSize, connect, describe as describeProvider } from '../../extension/src/lib/describeConnect'
import { createFakeAppex, createFakeBrowser, fakeDeps, INSTANCE, makeMirror, PUB, SEED } from './fakeBrowser'

const ORIGIN = 'https://app.example'
const CHALLENGE = b64uEncode(new Uint8Array(32).map((_, i) => i))
const EPOCH = '22222222-2222-4222-8222-222222222222'
const frame = (over: Partial<AttestedFrame> = {}): AttestedFrame => ({
  origin: ORIGIN,
  tabId: 1,
  frameId: 0,
  context: 'safari',
  ...over
})

const setup = (appexInit = {}) => {
  const browser = createFakeBrowser()
  const appex = createFakeAppex(appexInit)
  return { browser, appex, deps: fakeDeps(appex, browser) }
}
const ready = { mirrorState: 'ok' as const, mirror: makeMirror() }

describe('describe', () => {
  it('page origin differing from the attested origin is PROTOCOL_ERROR not-sent', async () => {
    const { deps, appex } = setup()
    const err = await describeProvider(deps, {
      frame: frame(),
      origin: 'https://evil.example',
      challenge: CHALLENGE
    }).catch(e => e)
    expect(err).toMatchObject({ domain: 'brc185', code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    expect(appex.requests).toHaveLength(0)
    await expect(connect(deps, { frame: frame(), origin: 'https://evil.example', epoch: EPOCH })).rejects.toMatchObject(
      { code: 'PROTOCOL_ERROR', delivery: 'not-sent' }
    )
  })

  it('a challenge that is not canonical base64url of 32 bytes is PROTOCOL_ERROR not-sent', async () => {
    const { deps } = setup()
    for (const challenge of ['short', CHALLENGE + '=', b64uEncode(new Uint8Array(31)), 12 as never]) {
      await expect(describeProvider(deps, { frame: frame(), origin: ORIGIN, challenge })).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
        delivery: 'not-sent'
      })
    }
  })

  it('describe preimage and response verify against the BRC-185 vectors (P1 fixture)', async () => {
    const V = vectors.descriptorProof
    expect(Buffer.from(SEED).toString('hex')).toBe(V.seedHex)
    expect(Buffer.from(PUB).toString('hex')).toBe(V.publicKeyHex)
    const { deps, appex } = setup()
    const resp = await describeProvider(deps, { frame: frame(), origin: V.input.origin, challenge: V.input.challenge })
    // The native side signed exactly the P1 preimage of the descriptor it was given.
    const signed = appex.requests.find(r => r.op === 'sign') as { preimage: string }
    expect(
      Buffer.from(signed.preimage, 'base64').equals(
        Buffer.from(
          describePreimage({ origin: V.input.origin, challenge: V.input.challenge, descriptor: resp.descriptor })
        )
      )
    ).toBe(true)
    expect(Buffer.from(signed.preimage, 'base64').toString().startsWith('BRC-185 descriptor v1\n')).toBe(true)
    // The published verifier accepts it, and the vector key is the descriptor's continuity key.
    const d = verifyDescribeProof(resp, { origin: V.input.origin, challenge: V.input.challenge })
    expect(d.instanceId).toBe(INSTANCE)
    expect(d.continuityKey).toBe(b64uEncode(ed25519.getPublicKey(SEED)))
    expect(d.endpoints).toEqual([{ id: 'window', type: 'window', address: 'safari-extension' }])
    expect(d.name).toBe('Bitcoin SV Wallet')
    expect(d.vendor).toBe('org.bsvblockchain.wallet')
    expect(d.instanceLabel).toBe('')
    expect(d.icon).toBeUndefined()
  })

  it('describe works with mirror absent and with readiness none', async () => {
    for (const init of [
      { mirrorState: 'absent' as const },
      { mirrorState: 'ok' as const, mirror: makeMirror({ readiness: 'none' }) }
    ]) {
      const { deps } = setup(init)
      const resp = await describeProvider(deps, { frame: frame(), origin: ORIGIN, challenge: CHALLENGE })
      expect(verifyDescribeProof(resp, { origin: ORIGIN, challenge: CHALLENGE }).instanceId).toBe(INSTANCE)
    }
  })

  it('uses the private context for a private tab', async () => {
    const { deps, appex } = setup()
    await describeProvider(deps, { frame: frame({ context: 'safari-private' }), origin: ORIGIN, challenge: CHALLENGE })
    expect(appex.requests.map(r => (r as { context?: string }).context).filter(Boolean)).toEqual([
      'safari-private',
      'safari-private'
    ])
  })

  it('describe with unavailable key rejects CONFIGURATION_ERROR', async () => {
    const { deps, appex } = setup({ keyMissing: true })
    const err = await describeProvider(deps, { frame: frame(), origin: ORIGIN, challenge: CHALLENGE }).catch(e => e)
    expect(isConnectionError(err)).toBe(true)
    expect(err).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent', cause: 'KEY_MISSING' })
    expect(appex.requests).toHaveLength(1) // a typed failure is not retried

    // A transport that is down or silent is a typed error too, never a hang.
    for (const init of [{ down: true }, { hang: true }]) {
      const s = setup(init)
      await expect(
        describeProvider(s.deps, { frame: frame(), origin: ORIGIN, challenge: CHALLENGE })
      ).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
        delivery: 'not-sent'
      })
      expect(s.appex.requests).toHaveLength(3) // 3 attempts
    }
  })

  it('describe response over 16384 bytes is refused', async () => {
    const { deps } = setup()
    const resp = await describeProvider(deps, { frame: frame(), origin: ORIGIN, challenge: CHALLENGE })
    expect(() => assertDescribeSize(resp)).not.toThrow()
    expect(() => assertDescribeSize(resp, 100)).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
    )
    // An oversize name never reaches the signer either: the descriptor is validated first.
    const long = setup()
    long.deps.name = 'x'.repeat(100)
    await expect(
      describeProvider(long.deps, { frame: frame(), origin: ORIGIN, challenge: CHALLENGE })
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR'
    })
    expect(long.appex.requests.some(r => r.op === 'sign')).toBe(false)
  })
})

describe('connect', () => {
  it('stamps and saves a binding keyed by (instanceId, epoch), returns no proof', async () => {
    const { deps, browser } = setup(ready)
    const out = await connect(deps, { frame: frame({ tabId: 4, frameId: 2 }), origin: ORIGIN, epoch: EPOCH })
    expect(out).toBeUndefined()
    const b = await loadBindings(browser.session)
    expect(b[`${INSTANCE}|${EPOCH}`]).toEqual({
      instanceId: INSTANCE,
      epoch: EPOCH,
      tabId: 4,
      frameId: 2,
      origin: ORIGIN,
      continuityKey: b64uEncode(PUB),
      accountContext: 'ctx-a',
      walletRevision: '5',
      boundAt: 1_000_000
    })
  })

  it('connect returns no proof', async () => {
    const { deps } = setup(ready)
    expect(await connect(deps, { frame: frame(), origin: ORIGIN, epoch: EPOCH })).toBeUndefined()
  })

  it('refuses a malformed epoch and an epoch reused by another frame', async () => {
    const { deps } = setup(ready)
    await expect(connect(deps, { frame: frame(), origin: ORIGIN, epoch: 'nope' })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR'
    })
    await connect(deps, { frame: frame(), origin: ORIGIN, epoch: EPOCH })
    await connect(deps, { frame: frame(), origin: ORIGIN, epoch: EPOCH }) // same frame: idempotent
    await expect(connect(deps, { frame: frame({ tabId: 9 }), origin: ORIGIN, epoch: EPOCH })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR'
    })
  })

  it('connect refused while building (no accountContext)', async () => {
    const building = makeMirror({ readiness: 'building', accountContext: '' })
    const { deps, browser } = setup({ mirrorState: 'ok', mirror: building })
    await expect(connect(deps, { frame: frame(), origin: ORIGIN, epoch: EPOCH })).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
      delivery: 'not-sent'
    })
    expect(await loadBindings(browser.session)).toEqual({})
  })

  it('connect refused when the mirror is absent, corrupt or none', async () => {
    for (const init of [
      { mirrorState: 'absent' as const },
      { mirrorState: 'corrupt' as const },
      { mirrorState: 'ok' as const, mirror: makeMirror({ readiness: 'none' }) }
    ]) {
      const { deps } = setup(init)
      await expect(connect(deps, { frame: frame(), origin: ORIGIN, epoch: EPOCH })).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
        delivery: 'not-sent'
      })
    }
  })

  it('binding caps 8 and 64', async () => {
    const { deps, browser } = setup(ready)
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
    for (let i = 0; i < 8; i++) await connect(deps, { frame: frame({ tabId: i }), origin: ORIGIN, epoch: uuid(i) })
    await expect(connect(deps, { frame: frame({ tabId: 99 }), origin: ORIGIN, epoch: uuid(99) })).rejects.toMatchObject(
      {
        code: 'RESOURCE_LIMIT',
        delivery: 'not-sent'
      }
    )
    // Another origin still fits, up to 64 overall.
    for (let i = 0; i < 56; i++) {
      const o = `https://site${i}.example`
      await connect(deps, { frame: frame({ origin: o, tabId: 100 + i }), origin: o, epoch: uuid(1000 + i) })
    }
    expect(Object.keys(await loadBindings(browser.session))).toHaveLength(64)
    const o = 'https://one-too-many.example'
    await expect(connect(deps, { frame: frame({ origin: o }), origin: o, epoch: uuid(5000) })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      delivery: 'not-sent'
    })
  })
})
