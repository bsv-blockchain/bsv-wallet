/**
 * XR-021: the paired-RPC anti-replay watermark (lastSeqRef) was advanced
 * in-memory ONLY, immediately before dispatching the wallet's side-effecting
 * method (createAction, signAction, etc.). The only durable persistence of
 * that watermark was a fire-and-forget `void SecureStore.setItemAsync(...)`
 * in disconnect()/onclose, never awaited before the dispatch. A crash/kill
 * in the window between the wallet call completing and that write landing
 * lets a captured ciphertext replay after reconnect and re-execute the
 * identical mutating call, because reconnect() seeds its floor from
 * whatever last reached SecureStore — which can be behind what actually ran.
 *
 * This drives the REAL WalletConnectionProvider through a real signed
 * pairing connect (same "no @bsv/sdk shortcuts" approach as
 * __tests__/context/walletConnectionLogout.test.tsx), then invokes the
 * real wireSocket onmessage handler directly with a crafted RPC envelope —
 * wallet.decrypt is mocked (its job is not what's under test here), so the
 * envelope's ciphertext content is irrelevant, only its shape.
 */
const mockSetItemAsync = jest.fn(async (..._args: unknown[]) => {})
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: jest.fn(async () => {})
}))

import { act, renderHook } from '@testing-library/react-native'
import React from 'react'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletConnectionProvider, useWalletConnection, lastSeqKey } from '../../core/context/WalletConnectionContext'
import { buildPairingSignatureMessage } from '../../core/services/walletConnectionValidation'

const mockWebSockets: any[] = []
const mockWebSocketConstructor = jest.fn(function (this: any, url: string) {
  this.url = url
  this.send = jest.fn()
  this.close = jest.fn()
  mockWebSockets.push(this)
})

beforeEach(() => {
  mockWebSockets.splice(0)
  mockWebSocketConstructor.mockClear()
  mockSetItemAsync.mockClear()
  mockSetItemAsync.mockImplementation(async () => {})
  ;(global as any).WebSocket = mockWebSocketConstructor
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ relay: 'wss://relay.example' })
  })) as any
})

async function signedPairingParams(topic: string) {
  const backendKey = PrivateKey.fromRandom()
  const backendIdentityKey = backendKey.toPublicKey().toString()
  const protocolID = JSON.stringify([0, 'wallet pairing'])
  const origin = 'https://app.example'
  const expiry = String(Math.floor(Date.now() / 1000) + 60)

  const message = buildPairingSignatureMessage({ topic, backendIdentityKey, protocolID, origin, expiry })
  const backendWallet = new ProtoWallet(backendKey)
  const { signature } = await backendWallet.createSignature({
    data: Array.from(new TextEncoder().encode(message)),
    protocolID: [0, 'qr pairing'],
    keyID: topic,
    counterparty: 'anyone'
  })
  const sig = Buffer.from(signature).toString('base64url')

  return { topic, backendIdentityKey, protocolID, origin, expiry, sig }
}

/** decrypt/encrypt are mocked — the replay-ordering bug is about sequence
 * persistence, not cryptography. `decryptedPlaintext` is a ref cell so each
 * test controls what the "peer" appears to have sent. */
function fakeMobileWallet(decryptedPlaintext: { current: string }) {
  const mobileKey = PrivateKey.fromRandom()
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: mobileKey.toPublicKey().toString() })),
    encrypt: jest.fn(async () => ({ ciphertext: [1, 2, 3] })),
    decrypt: jest.fn(async () => ({
      plaintext: Array.from(new TextEncoder().encode(decryptedPlaintext.current))
    })),
    createAction: jest.fn(async () => ({ txid: 'aa'.repeat(32) }))
  }
}

const activeUnmounts: Array<() => void> = []
afterEach(() => {
  activeUnmounts.splice(0).forEach(unmount => unmount())
})

async function connectFixture(topic: string) {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)
  const params = await signedPairingParams(topic)
  const decryptedPlaintext = { current: '' }
  const wallet = fakeMobileWallet(decryptedPlaintext)
  await act(async () => {
    await result.current.connect(params as any, wallet as any)
  })
  const ws = mockWebSockets[0]
  return { ws, wallet, decryptedPlaintext }
}

const rpcEnvelope = (topic: string) => JSON.stringify({ topic, ciphertext: 'AAAA' })

test('XR-021: durably persists the accepted sequence BEFORE dispatching the wallet call', async () => {
  const topic = 'xr021-topic-a'
  const { ws, wallet, decryptedPlaintext } = await connectFixture(topic)

  const order: string[] = []
  mockSetItemAsync.mockImplementation(async () => {
    order.push('persist-seq')
  })
  ;(wallet.createAction as jest.Mock).mockImplementation(async () => {
    order.push('dispatch-wallet-call')
    return { txid: 'aa'.repeat(32) }
  })

  decryptedPlaintext.current = JSON.stringify({ id: 'req-1', seq: 1, method: 'createAction', params: {} })
  await act(async () => {
    await ws.onmessage({ data: rpcEnvelope(topic) })
  })

  expect(mockSetItemAsync).toHaveBeenCalledWith(lastSeqKey(topic), '1')
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
  expect(order).toEqual(['persist-seq', 'dispatch-wallet-call'])
})

test('XR-021: fails closed — does not dispatch the wallet call when the durable write rejects', async () => {
  const topic = 'xr021-topic-b'
  const { ws, wallet, decryptedPlaintext } = await connectFixture(topic)

  mockSetItemAsync.mockImplementation(async () => {
    throw new Error('SecureStore write failed')
  })

  decryptedPlaintext.current = JSON.stringify({ id: 'req-1', seq: 1, method: 'createAction', params: {} })
  await act(async () => {
    await ws.onmessage({ data: rpcEnvelope(topic) })
  })

  expect(wallet.createAction).not.toHaveBeenCalled()
})

test('XR-021: a same-sequence replay after the durable watermark is still rejected on the same connection', async () => {
  const topic = 'xr021-topic-c'
  const { ws, wallet, decryptedPlaintext } = await connectFixture(topic)

  decryptedPlaintext.current = JSON.stringify({ id: 'req-1', seq: 1, method: 'createAction', params: {} })
  await act(async () => {
    await ws.onmessage({ data: rpcEnvelope(topic) })
  })
  expect(wallet.createAction).toHaveBeenCalledTimes(1)

  // Same seq again — the in-memory watermark (now 1) still rejects it
  // outright, same as before this fix; this is the ALREADY-existing part of
  // the defense, kept intact by moving the persistence earlier rather than
  // replacing this check.
  await act(async () => {
    await ws.onmessage({ data: rpcEnvelope(topic) })
  })
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
})

/** Lets any depth of already-queued microtasks (promise chains with no
 * timers/IO in between) settle without needing to count hops by hand. */
async function flushMicrotasks(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

test('XR-021: two concurrent messages whose durable writes resolve out of order do not regress the watermark or dispatch twice (review follow-up)', async () => {
  const topic = 'xr021-topic-race'
  const { ws, wallet, decryptedPlaintext } = await connectFixture(topic)

  // Each call is held open until its resolver is invoked, so the test
  // controls the ORDER the underlying SecureStore writes settle in,
  // independent of which message's onmessage ran first — reproducing the
  // out-of-order resolution MAX_IN_FLIGHT_RPC (>1) permits in production.
  const pendingWrites: Record<string, () => void> = {}
  mockSetItemAsync.mockImplementation(
    (_key: string, value: string) =>
      new Promise<void>(resolve => {
        pendingWrites[value] = resolve
      })
  )

  // Fire two messages "concurrently": neither's SecureStore write has
  // resolved when the second one's sequence check runs, so both check
  // against the same stale in-memory watermark (0).
  decryptedPlaintext.current = JSON.stringify({ id: 'req-6', seq: 6, method: 'createAction', params: {} })
  const p6 = ws.onmessage({ data: rpcEnvelope(topic) })
  decryptedPlaintext.current = JSON.stringify({ id: 'req-5', seq: 5, method: 'createAction', params: {} })
  const p5 = ws.onmessage({ data: rpcEnvelope(topic) })

  await flushMicrotasks()
  // Sanity: the higher-sequence message is actually parked on its durable
  // write, and nothing has dispatched yet — otherwise this isn't exercising
  // the race. (A correctly-serialized fix may not have even started seq=5's
  // write yet at this point — that's fine, and checked below instead.)
  expect(pendingWrites['6']).toBeDefined()
  expect(wallet.createAction).not.toHaveBeenCalled()

  // Let the HIGHER sequence's write win the race first...
  await act(async () => {
    pendingWrites['6']()
    await flushMicrotasks()
  })
  // ...then let the LOWER sequence's write resolve after it, if it was ever
  // started (a serialized fix may reject seq=5 before ever calling
  // SecureStore for it, once seq=6 has already advanced the watermark).
  await act(async () => {
    pendingWrites['5']?.()
    await flushMicrotasks()
    await p6
    await p5
  })

  // Only seq=6 may have dispatched a wallet call; seq=5 arrived after the
  // watermark had already moved past it and must be dropped, not executed
  // a second time.
  expect(wallet.createAction).toHaveBeenCalledTimes(1)

  // The watermark (in-memory AND durable) must reflect 6, not have
  // regressed to 5 — so a captured ciphertext for the already-executed
  // seq=6 request must NOT be accepted again.
  mockSetItemAsync.mockImplementation(async () => {})
  decryptedPlaintext.current = JSON.stringify({ id: 'req-6-replay', seq: 6, method: 'createAction', params: {} })
  await act(async () => {
    await ws.onmessage({ data: rpcEnvelope(topic) })
  })
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
})
