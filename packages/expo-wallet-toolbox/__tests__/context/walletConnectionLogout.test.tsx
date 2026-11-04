/**
 * XR-018 (logout half): WalletContext.tsx's logout() is a REACT ANCESTOR of
 * WalletConnectionProvider (app/_layout.tsx nests the connection provider
 * INSIDE WalletContextProvider), so it cannot call useWalletConnection()
 * itself. disconnectActivePairedSession() is the module-level bridge that
 * lets it revoke a live paired session anyway. This drives the REAL
 * provider through a real signed pairing connect (no mocking of
 * '@bsv/sdk' or the validation module — the same "no shortcuts" spirit as
 * __tests__/ui/pair.test.tsx) and proves the bridge actually closes the
 * live socket.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import React from 'react'
import { act, renderHook } from '@testing-library/react-native'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  WalletConnectionProvider,
  useWalletConnection,
  disconnectActivePairedSession
} from '../../core/context/WalletConnectionContext'
import connectionStore from '../../core/stores/ConnectionStore'
import { runSessionTeardown } from '../../core/context/sessionTeardown'
import { buildPairingSignatureMessage } from '../../core/services/walletConnectionValidation'

let mockOriginSession: Record<string, string> = {}
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
  global.fetch = jest.fn(async (url: string) => {
    const relayBody = JSON.stringify({ relay: 'wss://relay.example', ...mockOriginSession })
    return {
      ok: true,
      url,
      // XR-025: a real relay server declares Content-Length for a small,
      // deterministic JSON body -- the readBoundedRelayResponse fallback
      // now fails closed when it is absent and no stream reader exists.
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(relayBody.length) : null) },
      text: async () => relayBody
    }
  }) as any
})

afterEach(() => {
  // Providers from earlier tests must never leave a stale handle registered
  // for a later test's disconnectActivePairedSession() call to hit.
  disconnectActivePairedSession()
})

async function signedPairingParams(topic = 'xr018-logout-topic') {
  const backendKey = PrivateKey.fromRandom()
  const backendIdentityKey = backendKey.toPublicKey().toString()
  const protocolID = JSON.stringify([0, 'wallet pairing'])
  const origin = 'https://app.example'
  const expiry = String(Math.floor(Date.now() / 1000) + 60)

  const message = buildPairingSignatureMessage({ topic, backendIdentityKey, origin, expiry })
  const backendWallet = new ProtoWallet(backendKey)
  const { signature } = await backendWallet.createSignature({
    data: Array.from(new TextEncoder().encode(message)),
    protocolID: [0, 'qr pairing'],
    keyID: topic,
    counterparty: 'anyone'
  })
  const sig = Buffer.from(signature).toString('base64url')

  mockOriginSession = { topic, backendIdentityKey, protocolID }
  return { topic, backendIdentityKey, protocolID, origin, expiry, sig }
}

function fakeMobileWallet() {
  const mobileKey = PrivateKey.fromRandom()
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: mobileKey.toPublicKey().toString() })),
    encrypt: jest.fn(async () => ({ ciphertext: [1, 2, 3] })),
    decrypt: jest.fn(async () => ({ plaintext: [] }))
  }
}

test('XR-018: disconnectActivePairedSession() closes the live socket of a connected WalletConnectionProvider', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })

  const params = await signedPairingParams()
  const wallet = fakeMobileWallet()
  await act(async () => {
    await result.current.connect(params as any, wallet as any)
  })

  expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1)
  const ws = mockWebSockets[0]
  expect(ws.close).not.toHaveBeenCalled()

  act(() => {
    disconnectActivePairedSession()
  })

  expect(ws.close).toHaveBeenCalledTimes(1)
  unmount()
})

test('XR-018: disconnectActivePairedSession() is a safe no-op with no live session or no mounted provider', () => {
  expect(() => disconnectActivePairedSession()).not.toThrow()
})

test('relay registers for logout and profile only (a network switch keeps the pairing)', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  await act(async () => {
    await result.current.connect((await signedPairingParams()) as any, fakeMobileWallet() as any)
  })
  const ws = mockWebSockets[0]

  act(() => runSessionTeardown('network'))
  act(() => runSessionTeardown('rebuild'))
  expect(ws.close).not.toHaveBeenCalled()

  act(() => runSessionTeardown('profile'))
  expect(ws.close).toHaveBeenCalledTimes(1)
  unmount()

  // Unmount unregisters: a later logout touches nothing.
  expect(() => runSessionTeardown('logout')).not.toThrow()
})

for (const reason of ['disconnect', 'logout', 'profile'] as const) {
  test(`revokes a pairing still waiting for relay discovery on ${reason}`, async () => {
    const { result, unmount } = renderHook(() => useWalletConnection(), {
      wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
    })
    let release!: (response: any) => void
    ;(global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const wallet = fakeMobileWallet()
    const params = await signedPairingParams()
    const pending = result.current.connect(params as any, wallet as any)
    for (let i = 0; i < 40; i++) await Promise.resolve()
    expect(release).toBeDefined()
    act(() => {
      if (reason === 'disconnect') result.current.disconnect()
      else runSessionTeardown(reason)
    })
    const body = JSON.stringify({
      relay: 'wss://relay.example',
      topic: params.topic,
      backendIdentityKey: params.backendIdentityKey,
      protocolID: params.protocolID
    })
    release({
      ok: true,
      url: `${params.origin}/api/session/${encodeURIComponent(params.topic)}`,
      headers: { get: () => String(body.length) },
      text: async () => body
    })
    await act(async () => {
      await pending
    })
    expect(mockWebSocketConstructor).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.encrypt).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    unmount()
  })
}

test('deleting an inactive pairing revokes a reconnect still discovering its relay', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  const params = await signedPairingParams()
  const wallet = fakeMobileWallet()
  const { publicKey } = await wallet.getPublicKey()
  const connection = {
    sessionId: params.topic,
    origin: params.origin,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    mobileIdentityKey: publicKey,
    relay: 'wss://relay.example',
    connectedAt: Date.now(),
    status: 'disconnected' as const
  }
  connectionStore.add(connection)
  let release!: (response: any) => void
  ;(global.fetch as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const pending = result.current.reconnect(connection, wallet as any)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(release).toBeDefined()
  connectionStore.remove(connection.sessionId)
  const body = JSON.stringify({
    relay: 'wss://relay.example',
    topic: connection.sessionId,
    backendIdentityKey: connection.backendIdentityKey,
    protocolID: connection.protocolID
  })
  release({
    ok: true,
    url: `${connection.origin}/api/session/${encodeURIComponent(connection.sessionId)}`,
    headers: { get: () => String(body.length) },
    text: async () => body
  })
  await act(async () => {
    await pending
  })
  expect(mockWebSocketConstructor).not.toHaveBeenCalled()
  expect(require('expo-secure-store').deleteItemAsync).not.toHaveBeenCalled()
  unmount()
})

test('deleting an inactive pairing also revokes its already-wired reconnect before onopen', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  const wallet = fakeMobileWallet()
  const params = await signedPairingParams()
  await act(async () => {
    await result.current.connect(params as any, wallet as any)
  })
  const onopen = mockWebSockets[0].onopen
  connectionStore.remove(params.topic)
  await act(async () => {
    await onopen()
  })
  expect(wallet.encrypt).not.toHaveBeenCalled()
  unmount()
})

test('an older pending pairing cannot supersede a newer successful connection', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  let release!: (response: any) => void
  ;(global.fetch as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const wallet = fakeMobileWallet()
  const paramsA = await signedPairingParams('superseded-attempt')
  const paramsB = await signedPairingParams('current-attempt')
  const pending = result.current.connect(paramsA as any, wallet as any)
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await act(async () => {
    await result.current.connect(paramsB as any, wallet as any)
  })
  const body = JSON.stringify({
    relay: 'wss://relay.example',
    topic: paramsA.topic,
    backendIdentityKey: paramsA.backendIdentityKey,
    protocolID: paramsA.protocolID
  })
  release({
    ok: true,
    url: `${paramsA.origin}/api/session/${encodeURIComponent(paramsA.topic)}`,
    headers: { get: () => String(body.length) },
    text: async () => body
  })
  await act(async () => {
    await pending
  })
  expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1)
  expect(result.current.sessionMeta?.topic).toBe(paramsB.topic)
  expect(wallet.getPublicKey).toHaveBeenCalledTimes(1)
  unmount()
})

test('disconnect revokes a pairing awaiting its durable sequence floor', async () => {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  const secureStore = require('expo-secure-store')
  let release!: (value: string) => void
  secureStore.getItemAsync.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const wallet = fakeMobileWallet()
  const pending = result.current.connect((await signedPairingParams('pending-sequence-floor')) as any, wallet as any)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(release).toBeDefined()
  act(() => result.current.disconnect())
  release('0')
  await act(async () => {
    await pending
  })
  expect(wallet.getPublicKey).not.toHaveBeenCalled()
  expect(mockWebSocketConstructor).not.toHaveBeenCalled()
  unmount()
})
