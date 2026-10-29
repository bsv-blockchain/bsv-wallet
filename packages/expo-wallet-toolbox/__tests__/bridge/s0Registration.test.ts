jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import { ed25519 } from '@noble/curves/ed25519.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import {
  attachBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  initBridgeRuntime,
  onSnapshotChange,
  registerTransport,
  resetBridgeRuntimeForTests
} from '../../core/bridge/runtime'
import { hasUnattestedTransport, onUnattestedTransportChange } from '../../core/bridge/runtimeFlags'
import { b64uEncode } from '../../core/bridge/protocol/base64url'
import type { ContinuityHandle, ContinuityStore } from '../../core/bridge/protocol/continuity'
import { signDescribe, verifyDescribeProof, type Descriptor } from '../../core/bridge/protocol/descriptor'

/**
 * Spike S0 of the Android loopback kit (project 4): the P1 core already accepts the registration, the
 * continuity context and the explicit unattested connect the kit needs. Kept as a regression test.
 */

const ID = 'android-loopback'

function transport(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    attestation: 'unattested' as const,
    bindingMode: 'explicit' as const,
    requestAttention: jest.fn(),
    deliverReconnectToken: jest.fn(),
    ...over
  }
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
})

describe('S0 android-loopback registration', () => {
  it('(a) registers before initBridgeRuntime and flips the unattested flag', () => {
    const seen: boolean[] = []
    const off = onUnattestedTransportChange(p => seen.push(p))
    expect(hasUnattestedTransport()).toBe(false)
    const h = registerTransport(transport())
    expect(h).toMatchObject({ id: ID, attestation: 'unattested', bindingMode: 'explicit' })
    expect(hasUnattestedTransport()).toBe(true)
    expect(seen).toEqual([true])
    off()
  })

  it('(b) unattested-change listeners fire on register and unregister', () => {
    const seen: boolean[] = []
    const off = onUnattestedTransportChange(p => seen.push(p))
    const h = registerTransport(transport())
    h.unregister()
    expect(seen).toEqual([true, false])
    expect(hasUnattestedTransport()).toBe(false)
    off()
  })

  it('(c) an android: continuity context signs a describe response that verifies', async () => {
    const seed = new Uint8Array(32).map((_, i) => i + 1)
    const pub = ed25519.getPublicKey(seed)
    const handle: ContinuityHandle = {
      instanceId: '11111111-1111-4111-8111-111111111111',
      continuityKey: b64uEncode(pub),
      sign: async m => ed25519.sign(m, seed)
    }
    const contexts: string[] = []
    const store: ContinuityStore = {
      getOrCreate: async ctx => {
        contexts.push(ctx)
        return handle
      },
      reset: async () => undefined
    }
    const origin = 'https://example.com'
    const h = await store.getOrCreate('android:' + origin)
    const descriptor: Descriptor = {
      version: 1,
      instanceId: h.instanceId,
      name: 'Bitcoin SV Wallet',
      instanceLabel: 'Bitcoin SV Wallet',
      vendor: 'bsvblockchain.org',
      continuityKey: h.continuityKey,
      endpoints: [{ id: 'json-ipv4', type: 'http-json', address: 'http://127.0.0.1:3321' }]
    } as Descriptor
    const challenge = b64uEncode(new Uint8Array(32).map((_, i) => 255 - i))
    const resp = await signDescribe(h, { origin, challenge, descriptor })
    expect(verifyDescribeProof(resp, { origin, challenge }).instanceId).toBe(h.instanceId)
    expect(contexts).toEqual(['android:https://example.com'])
  })

  describe('(d) connectExplicit', () => {
    async function ready() {
      await initBridgeRuntime()
      registerTransport(transport())
    }
    const input = (over: Record<string, unknown> = {}) => ({
      epoch: '22222222-2222-4222-8222-222222222222',
      transportId: ID,
      applicationOrigin: 'https://example.com',
      attestation: 'unattested' as const,
      instanceId: '11111111-1111-4111-8111-111111111111',
      continuityKey: 'k',
      accountContext: 'ctx',
      walletRevision: '0',
      reconnectToken: 'tok',
      ...over
    })

    it('creates a binding with a verified launch proof and a reconnect token', async () => {
      await ready()
      const b = getBindingRegistry().connectExplicit(input({ launchProofVerified: true }))
      expect(b).toMatchObject({ transportId: ID, attestation: 'unattested', launchProofVerified: true, state: 'live' })
      expect(getBindingRegistry().takeReconnectToken(b.epoch)).toBe('tok')
    })

    it('throws CONFIGURATION_ERROR not-sent without launchProofVerified', async () => {
      await ready()
      expect(() => getBindingRegistry().connectExplicit(input())).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
      )
      expect(getBindingRegistry().live()).toHaveLength(0)
    })
  })

  it('(e) documents that attach and detach do not call onSnapshotChange while readiness stays none', async () => {
    // Task 2 closes this gap (hostAttached on the snapshot); this pins today's behaviour.
    await initBridgeRuntime()
    const seen: unknown[] = []
    const off = onSnapshotChange(s => seen.push(s))
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: false })
    expect(getBridgeSnapshot().readiness).toBe('none')
    expect(seen).toHaveLength(0)
    detach()
    expect(seen).toHaveLength(0)
    off()
  })
})
