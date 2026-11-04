import React from 'react'
import { act, renderHook } from '@testing-library/react-native'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import * as SecureStore from 'expo-secure-store'
import { WalletConnectionProvider, useWalletConnection } from '../../core/context/WalletConnectionContext'
import { buildPairingSignatureMessage } from '../../core/services/walletConnectionValidation'

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

const sockets: any[] = []
let originSession: Record<string, string>
const unmounts: Array<() => void> = []
const identity = new PrivateKey(37).toPublicKey().toString()
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
beforeEach(() => {
  sockets.splice(0)
  ;(SecureStore.getItemAsync as jest.Mock).mockReset().mockResolvedValue(null)
  ;(SecureStore.setItemAsync as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(global as any).WebSocket = jest.fn(function (this: any) {
    this.send = jest.fn()
    this.close = jest.fn()
    sockets.push(this)
  })
  global.fetch = jest.fn(async () => {
    const body = JSON.stringify({ relay: 'wss://relay.example', ...originSession })
    return { ok: true, headers: { get: () => String(body.length) }, text: async () => body }
  }) as any
})
afterEach(() => unmounts.splice(0).forEach(unmount => unmount()))

async function fixture() {
  const backend = new PrivateKey(41)
  const params = {
    topic: 'lifecycle-topic',
    backendIdentityKey: backend.toPublicKey().toString(),
    protocolID: '[0,"wallet pairing"]',
    origin: 'https://app.example',
    expiry: String(Math.floor(Date.now() / 1000) + 60),
    sig: ''
  }
  const { signature } = await new ProtoWallet(backend).createSignature({
    data: Array.from(new TextEncoder().encode(buildPairingSignatureMessage(params))),
    protocolID: [0, 'qr pairing'],
    keyID: params.topic,
    counterparty: 'anyone'
  })
  params.sig = Buffer.from(signature).toString('base64url')
  originSession = { topic: params.topic, backendIdentityKey: params.backendIdentityKey, protocolID: params.protocolID }
  const wallet = {
    getPublicKey: jest.fn(async () => ({ publicKey: identity })),
    encrypt: jest.fn(async (_args?: any) => ({ ciphertext: [1, 2, 3] })),
    decrypt: jest.fn(async () => ({
      plaintext: Array.from(
        new TextEncoder().encode(JSON.stringify({ id: 'read', seq: 1, method: 'listOutputs', params: {} }))
      )
    })),
    listOutputs: jest.fn(async () => ({ outputs: [] }))
  }
  const hook = renderHook(() => useWalletConnection(), {
    wrapper: ({ children }) => <WalletConnectionProvider>{children}</WalletConnectionProvider>
  })
  unmounts.push(hook.unmount)
  const connection = {
    sessionId: params.topic,
    origin: params.origin,
    relay: 'wss://relay.example',
    backendIdentityKey: params.backendIdentityKey,
    mobileIdentityKey: identity,
    protocolID: params.protocolID,
    connectedAt: Date.now(),
    status: 'disconnected' as const
  }
  const start = (mode: 'connect' | 'reconnect') =>
    mode === 'connect'
      ? hook.result.current.connect(params, wallet as any)
      : hook.result.current.reconnect(connection, wallet as any)
  return { ...hook, wallet, params, connection, start }
}

for (const mode of ['connect', 'reconnect'] as const) {
  test(`${mode}: opens the current socket and ignores retired open/error/close callbacks`, async () => {
    const f = await fixture()
    await act(async () => {
      await f.start(mode)
    })
    const ws = sockets[0]
    const { onopen, onerror, onclose } = ws
    await act(async () => {
      await onopen()
    })
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(f.wallet.encrypt.mock.calls[0][0].plaintext))).method
    ).toBe('pairing_approved')
    act(() => onerror())
    expect(f.result.current.status).toBe('error')
    act(() => f.result.current.disconnect())
    f.wallet.encrypt.mockClear()
    await act(async () => {
      await onopen()
      onerror()
      onclose()
    })
    expect(f.wallet.encrypt).not.toHaveBeenCalled()
    expect(f.result.current.status).toBe('idle')
  })

  test.each(['resolve', 'reject'] as const)(
    `${mode}: teardown during approval encryption (%s) prevents send and stale errors`,
    async outcome => {
      const f = await fixture()
      await act(async () => {
        await f.start(mode)
      })
      const ws = sockets[0]
      let resolve!: (value: { ciphertext: number[] }) => void
      let reject!: (error: Error) => void
      f.wallet.encrypt.mockImplementationOnce(
        () =>
          new Promise((res, rej) => {
            resolve = res
            reject = rej
          })
      )
      const pending = ws.onopen()
      act(() => f.result.current.disconnect())
      await act(async () => {
        if (outcome === 'resolve') resolve({ ciphertext: [1] })
        else reject(new Error('retired encryption'))
        await pending
      })
      expect(ws.send).not.toHaveBeenCalled()
      expect(f.result.current.status).toBe('idle')
      expect(f.result.current.errorMsg).toBeNull()
    }
  )

  test(`${mode}: an encryption failure on the current socket is reported`, async () => {
    const f = await fixture()
    await act(async () => {
      await f.start(mode)
    })
    f.wallet.encrypt.mockRejectedValueOnce(new Error('encryption failed'))
    await act(async () => {
      await sockets[0].onopen()
    })
    expect(f.result.current.status).toBe('error')
    expect(f.result.current.errorMsg).toBe(`Failed to send ${mode === 'connect' ? 'pairing' : 'reconnect'} message`)
    expect(sockets[0].send).not.toHaveBeenCalled()
  })

  test(`${mode}: teardown during wallet identity lookup prevents socket installation`, async () => {
    const f = await fixture()
    let release!: (value: { publicKey: string }) => void
    f.wallet.getPublicKey.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const pending = f.start(mode)
    await flush()
    expect(release).toBeDefined()
    act(() => f.result.current.disconnect())
    await act(async () => {
      release({ publicKey: identity })
      await pending
    })
    expect(sockets).toEqual([])
  })

  test(`${mode}: teardown during durable sequence read prevents socket installation`, async () => {
    const f = await fixture()
    let release!: (value: string) => void
    ;(SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const pending = f.start(mode)
    await flush()
    expect(release).toBeDefined()
    act(() => f.result.current.disconnect())
    await act(async () => {
      release('4')
      await pending
    })
    expect(sockets).toEqual([])
  })
}

test('disconnect immediately after connect entry revokes the in-progress real QR verification', async () => {
  const f = await fixture()
  let pending!: Promise<void>
  act(() => {
    pending = f.start('connect')
    f.result.current.disconnect()
  })
  await act(async () => {
    await pending
  })
  expect(global.fetch).not.toHaveBeenCalled()
  expect(f.wallet.getPublicKey).not.toHaveBeenCalled()
  expect(sockets).toEqual([])
})

test('a storage failure arriving after disconnect cannot restore an old connect error state', async () => {
  const f = await fixture()
  let reject!: (error: Error) => void
  ;(SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((_res, rej) => {
        reject = rej
      })
  )
  const pending = f.start('connect')
  await flush()
  act(() => f.result.current.disconnect())
  await act(async () => {
    reject(new Error('retired read failed'))
    await pending
  })
  expect(f.result.current.status).toBe('idle')
  expect(f.result.current.errorMsg).toBeNull()
  expect(sockets).toEqual([])
})

test('queued teardown after durable commit but before RPC dispatch prevents the wallet call', async () => {
  const f = await fixture()
  await act(async () => {
    await f.start('connect')
  })
  ;(SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(async () => {
    queueMicrotask(() => queueMicrotask(() => f.result.current.disconnect()))
  })
  await act(async () => {
    await sockets[0].onmessage({ data: JSON.stringify({ topic: f.params.topic, ciphertext: 'AAAA' }) })
  })
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
  expect(f.wallet.listOutputs).not.toHaveBeenCalled()
  expect(f.result.current.status).toBe('idle')
})
