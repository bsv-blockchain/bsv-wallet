jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

let mockUnlock: { status: string } = { status: 'unlocked' }
const mockUnlockListeners = new Set<() => void>()
jest.mock('../../core/services/secrets', () => ({
  getUnlockState: () => mockUnlock,
  subscribeUnlockState: (fn: () => void) => {
    mockUnlockListeners.add(fn)
    return () => mockUnlockListeners.delete(fn)
  }
}))

import React from 'react'
import { act, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { WalletContext, WalletManagersContext } from '../../core/context/WalletContext'
import { runSessionTeardown } from '../../core/context/sessionTeardown'
import { BrowserBridgeProvider } from '../../core/bridge/BrowserBridgeProvider'
import { dispatch } from '../../core/bridge/dispatcher'
import { getPendingConnections } from '../../core/bridge/consentSheetSource'
import {
  registerTransport,
  assertBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  resetBridgeRuntimeForTests
} from '../../core/bridge/runtime'

const flush = async () => {
  await act(async () => {
    await new Promise(r => setTimeout(r, 20))
  })
}

function fakeWalletStack(identity = '02aa') {
  return {
    signing: {} as any,
    permissions: { getPublicKey: jest.fn(async () => ({ publicKey: identity })) } as any
  }
}

type Stack = ReturnType<typeof fakeWalletStack>

function Harness(props: {
  stack?: Stack
  unverified?: Stack
  built?: boolean
  building?: boolean
  network?: string
  withdrawPrompts?: jest.Mock
  children?: React.ReactNode
}) {
  const { stack, built = !!stack, building = false, network = 'main', withdrawPrompts = jest.fn() } = props
  const managers = {
    signingPermissionsManager: stack?.signing,
    permissionsManager: stack?.permissions,
    unverifiedSigningPermissionsManager: props.unverified?.signing,
    unverifiedPermissionsManager: props.unverified?.permissions
  }
  const status: any = { walletBuilt: built, walletBuilding: building, selectedNetwork: network, withdrawPrompts }
  return (
    <WalletContext.Provider value={status}>
      <WalletManagersContext.Provider
        value={{ managers, storage: null, adminOriginator: 'admin.test', walletBuilding: building } as any}
      >
        <BrowserBridgeProvider>{props.children}</BrowserBridgeProvider>
      </WalletManagersContext.Provider>
    </WalletContext.Provider>
  )
}

beforeEach(async () => {
  mockUnlock = { status: 'unlocked' }
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
})

describe('BrowserBridgeProvider', () => {
  it('serves nothing until mounted, and nothing after it unmounts', async () => {
    expect(() => assertBridgeHost()).toThrow()
    const view = render(<Harness stack={fakeWalletStack()} />)
    await flush()
    expect(() => assertBridgeHost()).not.toThrow()
    view.unmount()
    expect(() => assertBridgeHost()).toThrow()
    expect(getBridgeSnapshot().readiness).toBe('none')
  })

  it('publishes readiness, network and an account context derived from the identity key', async () => {
    const stack = fakeWalletStack('02aa')
    const view = render(<Harness building />)
    await flush()
    expect(getBridgeSnapshot().readiness).toBe('building')

    view.rerender(<Harness stack={stack} />)
    await flush()
    const snap = getBridgeSnapshot()
    expect(snap).toMatchObject({ readiness: 'ready', network: 'main', walletRevision: '0' })
    expect(snap.accountContext).toMatch(/^[0-9a-f]{64}$/)
    expect(stack.permissions.getPublicKey).toHaveBeenCalledWith({ identityKey: true }, 'admin.test')

    view.rerender(<Harness stack={stack} network="test" />)
    await flush()
    expect(getBridgeSnapshot().network).toBe('test')
    expect(getBridgeSnapshot().accountContext).not.toBe(snap.accountContext)
  })

  it('is building, not ready, until the account context for this wallet is in hand', async () => {
    const first = fakeWalletStack('02aa')
    const view = render(<Harness stack={first} />)
    await flush()
    const ctxA = getBridgeSnapshot().accountContext
    // A rebuilt wallet with a slow identity key: never publishes the last wallet's context as its own.
    let release!: (v: { publicKey: string }) => void
    const slow = fakeWalletStack('02bb')
    slow.permissions.getPublicKey = jest.fn(() => new Promise(r => (release = r)))
    view.rerender(<Harness stack={slow} />)
    await act(async () => {})
    expect(getBridgeSnapshot()).toMatchObject({ readiness: 'building', accountContext: '' })
    await act(async () => {
      release({ publicKey: '02bb' })
      await new Promise(r => setTimeout(r, 20))
    })
    expect(getBridgeSnapshot().readiness).toBe('ready')
    expect(getBridgeSnapshot().accountContext).not.toBe(ctxA)
  })

  it('is blocked while the secrets layer is locked', async () => {
    mockUnlock = { status: 'locked' }
    const view = render(<Harness stack={fakeWalletStack()} />)
    await flush()
    expect(getBridgeSnapshot().readiness).toBe('blocked')
    mockUnlock = { status: 'unlocked' }
    await act(async () => mockUnlockListeners.forEach(f => f()))
    await flush()
    expect(getBridgeSnapshot().readiness).toBe('ready')
    view.unmount()
  })

  it('same-wallet rebuild bumps revision through the provider and withdraws the old prompts', async () => {
    const withdrawPrompts = jest.fn()
    const first = fakeWalletStack('02aa')
    const view = render(<Harness stack={first} withdrawPrompts={withdrawPrompts} />)
    await flush()
    const ctx = getBridgeSnapshot().accountContext
    getBindingRegistry().connectExplicit({
      epoch: 'e1',
      transportId: 't',
      applicationOrigin: 'https://a.example',
      attestation: 'browser',
      instanceId: 'i',
      continuityKey: 'k',
      accountContext: ctx,
      walletRevision: '0'
    })

    // Same identity and network, new manager objects.
    const second = fakeWalletStack('02aa')
    view.rerender(<Harness stack={second} withdrawPrompts={withdrawPrompts} />)
    await flush()
    expect(getBridgeSnapshot()).toMatchObject({ walletRevision: '1', accountContext: ctx, readiness: 'ready' })
    expect(getBindingRegistry().live()).toHaveLength(0)
    expect(withdrawPrompts).toHaveBeenCalledWith([first.signing])
  })

  it('a profile switch closes bindings; the next wallet is a new revision', async () => {
    const withdrawPrompts = jest.fn()
    const view = render(<Harness stack={fakeWalletStack('02aa')} withdrawPrompts={withdrawPrompts} />)
    await flush()
    getBindingRegistry().connectExplicit({
      epoch: 'e1',
      transportId: 't',
      applicationOrigin: 'https://a.example',
      attestation: 'browser',
      instanceId: 'i',
      continuityKey: 'k',
      accountContext: getBridgeSnapshot().accountContext,
      walletRevision: '0'
    })
    runSessionTeardown('profile')
    expect(getBindingRegistry().live()).toHaveLength(0)
    view.rerender(<Harness built={false} building withdrawPrompts={withdrawPrompts} />)
    await flush()
    expect(getBridgeSnapshot().readiness).toBe('building')
    view.rerender(<Harness stack={fakeWalletStack('02cc')} withdrawPrompts={withdrawPrompts} />)
    await flush()
    expect(getBridgeSnapshot().walletRevision).toBe('1')
    expect(withdrawPrompts).toHaveBeenCalledTimes(1)
  })

  it('publishes the unverified manager alongside the attested one', async () => {
    const view = render(<Harness stack={fakeWalletStack()} unverified={fakeWalletStack()} />)
    await flush()
    const { getPublishedManagers } = require('../../core/bridge/runtime')
    expect(getPublishedManagers().unverified).toBeDefined()
    view.unmount()
  })

  it('wires the consent store, dispatcher and sheet source once the wallet is ready, and removes them on unmount', async () => {
    registerTransport({ id: 't', attestation: 'browser', bindingMode: 'explicit', requestAttention: jest.fn() })
    const send = (epoch: string) =>
      dispatch({
        transport: 't',
        request: {
          epoch,
          instanceId: 'i',
          continuityKey: 'k',
          origin: 'https://a.example',
          method: 'getHeight',
          args: {},
          sizeBytes: 10
        }
      })
    const connect = (epoch: string) =>
      getBindingRegistry().connectExplicit({
        epoch,
        transportId: 't',
        applicationOrigin: 'https://a.example',
        attestation: 'browser',
        instanceId: 'i',
        continuityKey: 'k',
        accountContext: getBridgeSnapshot().accountContext,
        walletRevision: getBridgeSnapshot().walletRevision
      })

    // Before any wallet: nothing is installed.
    const view = render(<Harness building />)
    await flush()
    expect(await send('nope')).toMatchObject({ ok: false, connectionError: { code: 'CONFIGURATION_ERROR' } })

    view.rerender(<Harness stack={fakeWalletStack()} />)
    await flush()
    expect(getBridgeSnapshot().readiness).toBe('ready')
    connect('e1')
    const parked = send('e1')
    await flush()
    expect(getPendingConnections()).toMatchObject([
      { origin: 'https://a.example', attestation: 'browser', connectedBefore: false, profileKey: '' }
    ])

    // Unmount withdraws the request and uninstalls the dispatcher and the sheet source.
    view.unmount()
    expect(await parked).toMatchObject({ ok: false })
    expect(getPendingConnections()).toEqual([])
    expect(await send('e1')).toMatchObject({ ok: false, connectionError: { code: 'CONFIGURATION_ERROR' } })
  })
})
