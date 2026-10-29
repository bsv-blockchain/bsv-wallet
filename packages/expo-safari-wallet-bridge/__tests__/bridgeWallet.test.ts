/** @jest-environment node */
import { BRIDGE_WALLET_METHODS, createBridgeWallet, toWalletError } from '../demo/bridgeWallet'
import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import { createWalletClient, setBridgeConnection } from '../demo/conformance/snippets/wallet'
import type { Connection, PageClient } from '../src/testing/pageClient'

const connection = { epoch: 'e' } as unknown as Connection

function fakeClient(impl?: (method: string, args: unknown) => unknown) {
  const calls: [Connection, string, unknown][] = []
  const client = {
    invoke: jest.fn(async (c: Connection, m: string, a: unknown) => {
      calls.push([c, m, a])
      if (impl) return impl(m, a)
      return { method: m }
    })
  } as unknown as PageClient
  return { client, calls }
}

describe('createBridgeWallet', () => {
  it('covers exactly the 28 BRC-100 methods the bridge carries', () => {
    expect(BRIDGE_WALLET_METHODS).toHaveLength(28)
    expect([...BRIDGE_WALLET_METHODS].sort()).toEqual(Object.keys(BRIDGE_METHODS).sort())
  })

  it('forwards every method with its args through client.invoke', async () => {
    const { client, calls } = fakeClient()
    const wallet = createBridgeWallet(client, connection) as unknown as Record<string, (a: unknown) => Promise<unknown>>
    for (const m of BRIDGE_WALLET_METHODS) {
      const args = { probe: m }
      await expect(wallet[m](args)).resolves.toEqual({ method: m })
    }
    expect(calls).toHaveLength(28)
    for (const [i, m] of BRIDGE_WALLET_METHODS.entries()) {
      expect(calls[i][0]).toBe(connection)
      expect(calls[i][1]).toBe(m)
      expect(calls[i][2]).toEqual({ probe: m })
    }
  })

  it('sends {} when a method is called without args', async () => {
    const { client, calls } = fakeClient()
    await createBridgeWallet(client, connection).getVersion(undefined as never)
    expect(calls[0][2]).toEqual({})
  })

  it('keeps the code, name and message of a wallet Error (same object)', async () => {
    const boom = Object.assign(new Error('Permission denied.'), { code: 'ERR_PERMISSION_DENIED', name: 'WERR_X' })
    const { client } = fakeClient(() => {
      throw boom
    })
    await expect(createBridgeWallet(client, connection).getVersion({})).rejects.toBe(boom)
  })

  it('rebuilds a plain wire error object as an Error with code, name, message and extra fields', async () => {
    const { client } = fakeClient(() => {
      throw { code: 6, name: 'WERR_INVALID_PARAMETER', message: 'bad', parameter: 'x', isError: true }
    })
    const err: any = await createBridgeWallet(client, connection)
      .getVersion({})
      .catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ code: 6, name: 'WERR_INVALID_PARAMETER', message: 'bad', parameter: 'x' })
  })

  it('gives a thrown string or an object without a message a usable Error', () => {
    expect(toWalletError('nope')).toMatchObject({ message: 'nope', code: 1 })
    expect(toWalletError({ code: 'ERR_INVALID_HMAC' })).toMatchObject({
      code: 'ERR_INVALID_HMAC',
      message: 'Wallet call failed'
    })
  })

  it('leaves a ConnectionError untouched so it is never taken for a wallet rejection', async () => {
    const ce = Object.assign(new Error('closed'), {
      domain: 'brc185',
      code: 'connection_closed',
      delivery: 'not_delivered'
    })
    const { client } = fakeClient(() => {
      throw ce
    })
    await expect(createBridgeWallet(client, connection).getVersion({})).rejects.toBe(ce)
  })

  it('not connected: every method fails with a clear error and never calls the client', async () => {
    const { client } = fakeClient()
    const wallet = createBridgeWallet(client, undefined) as unknown as Record<string, (a: unknown) => Promise<unknown>>
    for (const m of BRIDGE_WALLET_METHODS)
      await expect(wallet[m]({})).rejects.toThrow(/not connected: press connect first/)
    expect(client.invoke).not.toHaveBeenCalled()
  })
})

describe('createWalletClient (vendored snippets factory)', () => {
  afterEach(() => setBridgeConnection(undefined, undefined))

  it('throws a clear error until the demo has connected', () => {
    expect(() => createWalletClient()).toThrow(/not connected: press connect first/)
  })

  it('returns an SDK WalletClient over the current connection', async () => {
    const { client, calls } = fakeClient(() => ({ version: 'test-1.0.0' }))
    setBridgeConnection(client, connection)
    await createWalletClient('ignored.example').getVersion({})
    expect(calls[0][1]).toBe('getVersion')
    setBridgeConnection(undefined, undefined)
    expect(() => createWalletClient()).toThrow(/not connected/)
  })
})
