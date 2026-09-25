/**
 * XR-025 (SEC2-094): readBoundedRelayResponse intends to cap the relay
 * discovery response at MAX_RELAY_RESPONSE_BYTES, but on a runtime whose
 * fetch implementation exposes neither a declared Content-Length nor a
 * streamable response body, it fell through to `await res.text()` and only
 * measured the result AFTERWARD -- an attacker-controlled canonical origin
 * (drawn straight from signed pairing/QR data) could pace a large,
 * length-less body to be fully buffered before the size check ever ran.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import { fetchRelay } from '../../core/context/WalletConnectionContext'
import { MAX_RELAY_RESPONSE_BYTES } from '../../core/services/walletConnectionValidation'

afterEach(() => {
  jest.restoreAllMocks()
})

it('XR-025: refuses a length-less, non-streaming relay response rather than buffering it in full', async () => {
  const textSpy = jest.fn().mockResolvedValue('x'.repeat(MAX_RELAY_RESPONSE_BYTES * 100))
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => null }, // no declared Content-Length
    body: undefined, // no streamable body -- the degraded fallback runtime
    text: textSpy
  }) as any

  await expect(fetchRelay('https://app.example', 'topic-123')).rejects.toThrow(/too large|length/i)
  // The whole point of the fix: the oversized body must never be buffered at
  // all when there is no way to bound it as it arrives.
  expect(textSpy).not.toHaveBeenCalled()
})

it('still resolves an ordinary relay response that declares an accurate Content-Length', async () => {
  const body = JSON.stringify({ relay: 'wss://relay.example' })
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(body.length) : null) },
    body: undefined,
    text: jest.fn().mockResolvedValue(body)
  }) as any

  await expect(fetchRelay('https://app.example', 'topic-123')).resolves.toBe('wss://relay.example')
})

it('still resolves an ordinary relay response streamed through a WHATWG body reader', async () => {
  const body = JSON.stringify({ relay: 'wss://relay.example' })
  const bytes = new TextEncoder().encode(body)
  let read = false
  const reader = {
    read: jest.fn(async () => {
      if (read) return { done: true, value: undefined }
      read = true
      return { done: false, value: bytes }
    }),
    cancel: jest.fn()
  }
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => reader }
  }) as any

  await expect(fetchRelay('https://app.example', 'topic-123')).resolves.toBe('wss://relay.example')
})
