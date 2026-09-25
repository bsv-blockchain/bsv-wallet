/**
 * XR-018 (orphan-socket half): the disconnect-button and logout() paths were
 * fixed first (walletConnectionLogout.test.tsx, connectionsDeepLinks.test.tsx),
 * but a completeness re-check found the finding's THIRD entry point still
 * open at HEAD: wireSocket() unconditionally does `wsRef.current = ws`
 * without closing whatever socket it replaces, and neither connect() nor
 * reconnect() closed/detached an existing live socket before opening a new
 * one. ConnectionsScreen.handleReconnect and PairScreen.handleApprove both
 * call reconnect()/connect() with no check of whether a DIFFERENT session
 * is already live — so approving a second pairing, or reconnecting a saved
 * connection, while one session is already connected silently orphaned the
 * first socket with full RPC authority intact (its onmessage closure kept
 * decrypting and dispatching handleRpc for as long as the relay left it
 * open).
 *
 * This drives the REAL WalletConnectionProvider through two real signed
 * pairing connects (same "no @bsv/sdk shortcuts" approach as
 * walletConnectionLogout.test.tsx / walletConnectionReplay.test.tsx) and
 * proves the FIRST socket can no longer dispatch any RPC once a second
 * connect()/reconnect() supersedes it, or once disconnect() tears it down —
 * including the race where a message was already mid-flight (decrypting)
 * on the old socket at the moment it was superseded.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import React from 'react'
import { act, renderHook } from '@testing-library/react-native'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletConnectionProvider, useWalletConnection } from '../../core/context/WalletConnectionContext'
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
  ;(global as any).WebSocket = mockWebSocketConstructor
  global.fetch = jest.fn(async () => {
    const relayBody = JSON.stringify({ relay: 'wss://relay.example' })
    return {
      ok: true,
      // XR-025: a real relay server declares Content-Length for a small,
      // deterministic JSON body -- the readBoundedRelayResponse fallback
      // now fails closed when it is absent and no stream reader exists.
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(relayBody.length) : null) },
      text: async () => relayBody
    }
  }) as any
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

/** decrypt is controllable per-call via a queue, so a test can hold a
 * message "mid-flight" (decrypting) across a supersede/disconnect. encrypt
 * is a fixed stub — its output is never inspected by these tests. */
function fakeMobileWallet() {
  const mobileKey = PrivateKey.fromRandom()
  const decryptQueue: Array<{ resolve: (v: { plaintext: number[] }) => void }> = []
  const decrypt = jest.fn(() => new Promise<{ plaintext: number[] }>(resolve => {
    decryptQueue.push({ resolve })
  }))
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: mobileKey.toPublicKey().toString() })),
    encrypt: jest.fn(async () => ({ ciphertext: [1, 2, 3] })),
    decrypt,
    listOutputs: jest.fn(async () => ({ outputs: [] })),
    __decryptQueue: decryptQueue,
    __resolveNextDecrypt(plaintext: string) {
      const next = decryptQueue.shift()
      if (!next) throw new Error('no pending decrypt() call to resolve')
      next.resolve({ plaintext: Array.from(new TextEncoder().encode(plaintext)) })
    }
  }
}

const rpcEnvelope = (topic: string) => JSON.stringify({ topic, ciphertext: 'AAAA' })

const activeUnmounts: Array<() => void> = []
afterEach(() => {
  activeUnmounts.splice(0).forEach(unmount => unmount())
})

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

test('XR-018: connect() closes and fully detaches a previous live socket for a DIFFERENT session before opening a new one', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)

  const wallet = fakeMobileWallet()
  const paramsA = await signedPairingParams('xr018-orphan-topic-a')
  await act(async () => {
    await result.current.connect(paramsA as any, wallet as any)
  })
  expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1)
  const ws1 = mockWebSockets[0]
  // Capture the handler wireSocket installed on ws1 BEFORE it gets
  // superseded, so we can prove below that even a stale direct reference to
  // it (not just ws1.onmessage itself) can no longer dispatch RPC.
  const staleOnMessage = ws1.onmessage
  expect(typeof staleOnMessage).toBe('function')
  expect(ws1.close).not.toHaveBeenCalled()

  const paramsB = await signedPairingParams('xr018-orphan-topic-b')
  await act(async () => {
    await result.current.connect(paramsB as any, wallet as any)
  })
  expect(mockWebSocketConstructor).toHaveBeenCalledTimes(2)
  const ws2 = mockWebSockets[1]
  expect(ws2).not.toBe(ws1)

  // The old socket must be closed AND fully detached — a live paired socket
  // for a session this provider has moved on from must not be able to fire
  // any handler again.
  expect(ws1.close).toHaveBeenCalledTimes(1)
  expect(ws1.onmessage).toBeNull()
  expect(ws1.onopen).toBeNull()
  expect(ws1.onerror).toBeNull()
  expect(ws1.onclose).toBeNull()

  // Defense in depth: even a caller holding the OLD closure directly
  // (bypassing the now-nulled ws1.onmessage property) must not be able to
  // dispatch a privileged RPC method through it — the generation check at
  // the top of onmessage rejects it before decrypt is even attempted.
  wallet.decrypt.mockClear()
  wallet.listOutputs.mockClear()
  await act(async () => {
    await staleOnMessage({ data: rpcEnvelope(paramsA.topic) })
    await flushMicrotasks()
  })
  expect(wallet.decrypt).not.toHaveBeenCalled()
  expect(wallet.listOutputs).not.toHaveBeenCalled()
  expect(ws1.send).not.toHaveBeenCalled()
})

test('XR-018: a message already mid-decrypt on the old socket at the moment connect() supersedes it is dropped, not dispatched', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)

  const wallet = fakeMobileWallet()
  const paramsA = await signedPairingParams('xr018-race-topic-a')
  await act(async () => {
    await result.current.connect(paramsA as any, wallet as any)
  })
  const ws1 = mockWebSockets[0]

  // Start processing a message on ws1 — it will be parked awaiting
  // wallet.decrypt(), simulating the window where a concurrent
  // connect()/reconnect()/disconnect() can supersede this socket before the
  // in-flight message finishes.
  let onmessagePromise!: Promise<void>
  act(() => {
    onmessagePromise = ws1.onmessage({ data: rpcEnvelope(paramsA.topic) })
  })
  await flushMicrotasks()
  expect(wallet.decrypt).toHaveBeenCalledTimes(1)

  // Supersede ws1 with a fresh connect() WHILE the above decrypt is still
  // pending — this is the exact race the generation check exists for.
  const paramsB = await signedPairingParams('xr018-race-topic-b')
  await act(async () => {
    await result.current.connect(paramsB as any, wallet as any)
  })
  expect(ws1.close).toHaveBeenCalledTimes(1)

  // Now let the stale decrypt resolve with a well-formed, in-sequence RPC
  // request. Closing/detaching ws1's handler earlier cannot cancel this
  // already-running invocation — only the generation check can stop it.
  await act(async () => {
    wallet.__resolveNextDecrypt(JSON.stringify({ id: 'req-1', seq: 1, method: 'listOutputs', params: {} }))
    await onmessagePromise
  })

  expect(wallet.listOutputs).not.toHaveBeenCalled()
  expect(ws1.send).not.toHaveBeenCalled()
})

test('XR-018: reconnect() closes and fully detaches a previous live socket for a DIFFERENT session before opening a new one', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)

  const wallet = fakeMobileWallet()
  const paramsA = await signedPairingParams('xr018-reconnect-topic-a')
  await act(async () => {
    await result.current.connect(paramsA as any, wallet as any)
  })
  const ws1 = mockWebSockets[0]
  const staleOnMessage = ws1.onmessage

  // A stored connection for a DIFFERENT session's topic, belonging to the
  // same wallet identity (reconnect() requires the identity key to match).
  const identity = await wallet.getPublicKey()
  const storedConnection = {
    sessionId: 'xr018-reconnect-topic-b',
    origin: 'https://app.example',
    relay: 'wss://relay.example',
    backendIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    mobileIdentityKey: identity.publicKey,
    protocolID: JSON.stringify([0, 'wallet pairing']),
    connectedAt: Date.now(),
    status: 'disconnected' as const
  }

  await act(async () => {
    await result.current.reconnect(storedConnection as any, wallet as any)
  })
  const ws2 = mockWebSockets[1]
  expect(ws2).not.toBe(ws1)

  expect(ws1.close).toHaveBeenCalledTimes(1)
  expect(ws1.onmessage).toBeNull()

  wallet.decrypt.mockClear()
  wallet.listOutputs.mockClear()
  await act(async () => {
    await staleOnMessage({ data: rpcEnvelope(paramsA.topic) })
    await flushMicrotasks()
  })
  expect(wallet.decrypt).not.toHaveBeenCalled()
  expect(wallet.listOutputs).not.toHaveBeenCalled()
  expect(ws1.send).not.toHaveBeenCalled()
})

test('XR-018: disconnect() prevents a message already mid-decrypt on the live socket from dispatching', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)

  const wallet = fakeMobileWallet()
  const params = await signedPairingParams('xr018-disconnect-race-topic')
  await act(async () => {
    await result.current.connect(params as any, wallet as any)
  })
  const ws = mockWebSockets[0]

  let onmessagePromise!: Promise<void>
  act(() => {
    onmessagePromise = ws.onmessage({ data: rpcEnvelope(params.topic) })
  })
  await flushMicrotasks()
  expect(wallet.decrypt).toHaveBeenCalledTimes(1)

  act(() => {
    result.current.disconnect()
  })
  expect(ws.close).toHaveBeenCalledTimes(1)
  expect(ws.onmessage).toBeNull()

  await act(async () => {
    wallet.__resolveNextDecrypt(JSON.stringify({ id: 'req-1', seq: 1, method: 'listOutputs', params: {} }))
    await onmessagePromise
  })

  expect(wallet.listOutputs).not.toHaveBeenCalled()
  expect(ws.send).not.toHaveBeenCalled()
})
