/**
 * XR-026: MAX_IN_FLIGHT_RPC (4) bounds the COUNT of concurrent paired-RPC
 * messages, but each can independently be up to MAX_RPC_PLAINTEXT_BYTES
 * (5 MiB) — so up to 4 near-ceiling messages decrypting at once multiplies
 * that ceiling before the ~20-30x native amplification documented in
 * walletArgLimits.ts (a single ~5 MiB call is already ~100-150 MB of peak
 * RSS). There was no process-wide in-flight byte budget tying the two
 * together.
 *
 * This drives the REAL WalletConnectionProvider through a real signed
 * pairing connect (same approach as the other __tests__/context/
 * walletConnection*.test.tsx files), then sends two large RPC envelopes
 * back-to-back while the first's decrypt is still pending (controlled via a
 * manually-released promise) and asserts the second is dropped — its
 * decrypt is never even attempted — because their combined estimated size
 * would exceed the shared in-flight byte budget. Once the first resolves and
 * releases its reservation, a further same-size message succeeds.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import { act, renderHook } from '@testing-library/react-native'
import React from 'react'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletConnectionProvider, useWalletConnection } from '../../core/context/WalletConnectionContext'
import { buildPairingSignatureMessage, MAX_IN_FLIGHT_RPC_BYTES } from '../../core/services/walletConnectionValidation'

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

const activeUnmounts: Array<() => void> = []
afterEach(() => {
  activeUnmounts.splice(0).forEach(unmount => unmount())
})

async function signedPairingParams(topic: string) {
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

  return { topic, backendIdentityKey, protocolID, origin, expiry, sig }
}

function fakeMobileWallet() {
  const mobileKey = PrivateKey.fromRandom()
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: mobileKey.toPublicKey().toString() })),
    encrypt: jest.fn(async () => ({ ciphertext: [1, 2, 3] })),
    decrypt: jest.fn(),
    listOutputs: jest.fn(async () => ({ outputs: [], totalOutputs: 0 }))
  }
}

async function connectFixture(topic: string) {
  const { result, unmount } = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  activeUnmounts.push(unmount)
  const params = await signedPairingParams(topic)
  const wallet = fakeMobileWallet()
  await act(async () => {
    await result.current.connect(params as any, wallet as any)
  })
  const ws = mockWebSockets[0]
  return { ws, wallet }
}

/** A base64url ciphertext string whose decoded length is exactly `bytes`. */
const ciphertextOfBytes = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3))

const rpcEnvelope = (topic: string, ciphertext: string) => JSON.stringify({ topic, ciphertext })

/** Under MAX_IN_FLIGHT_RPC_BYTES alone, but combined with itself exceeds it. */
const HALF_PLUS = Math.ceil(MAX_IN_FLIGHT_RPC_BYTES * 0.6)

test('XR-026: a second large message is dropped while the first is still decrypting, and freed once it resolves', async () => {
  const topic = 'xr026-topic-a'
  const { ws, wallet } = await connectFixture(topic)

  let releaseFirstDecrypt!: (v: { plaintext: number[] }) => void
  ;(wallet.decrypt as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseFirstDecrypt = resolve
      })
  )

  // First message: starts decrypting, reserves its estimated bytes, and
  // suspends (does not resolve) — deliberately not awaited (and not
  // act()-wrapped) here; it is flushed properly once released below.
  const firstEnvelope = rpcEnvelope(topic, ciphertextOfBytes(HALF_PLUS))
  const firstDone = ws.onmessage({ data: firstEnvelope })

  // Second message, sent while the first is still in flight: combined
  // estimated bytes exceed the shared budget, so it must be dropped BEFORE
  // decrypt is ever attempted for it.
  const secondEnvelope = rpcEnvelope(topic, ciphertextOfBytes(HALF_PLUS))
  await act(async () => {
    await ws.onmessage({ data: secondEnvelope })
  })
  expect(wallet.decrypt).toHaveBeenCalledTimes(1)

  // Release the first message's decrypt so its reservation is freed.
  releaseFirstDecrypt({
    plaintext: Array.from(
      new TextEncoder().encode(JSON.stringify({ id: 'r1', seq: 1, method: 'listOutputs', params: {} }))
    )
  })
  await act(async () => {
    await firstDone
  })

  // A THIRD message, of the same size, now fits again — the reservation was
  // actually released, not leaked.
  ;(wallet.decrypt as jest.Mock).mockResolvedValueOnce({
    plaintext: Array.from(
      new TextEncoder().encode(JSON.stringify({ id: 'r2', seq: 2, method: 'listOutputs', params: {} }))
    )
  })
  const thirdEnvelope = rpcEnvelope(topic, ciphertextOfBytes(HALF_PLUS))
  await act(async () => {
    await ws.onmessage({ data: thirdEnvelope })
  })
  expect(wallet.decrypt).toHaveBeenCalledTimes(2)
})
