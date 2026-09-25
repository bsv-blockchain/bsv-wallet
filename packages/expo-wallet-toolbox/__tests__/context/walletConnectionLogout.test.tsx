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
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ relay: 'wss://relay.example' })
  })) as any
})

afterEach(() => {
  // Providers from earlier tests must never leave a stale handle registered
  // for a later test's disconnectActivePairedSession() call to hit.
  disconnectActivePairedSession()
})

async function signedPairingParams() {
  const topic = 'xr018-logout-topic'
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
