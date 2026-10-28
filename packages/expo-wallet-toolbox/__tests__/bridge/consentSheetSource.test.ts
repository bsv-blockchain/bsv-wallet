jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import {
  answerConnection,
  connectionFlags,
  getPendingConnections,
  setConsentSheetSource
} from '../../core/bridge/consentSheetSource'
import {
  getBindingRegistry,
  initBridgeRuntime,
  publish,
  registerTransport,
  resetBridgeRuntimeForTests
} from '../../core/bridge/runtime'
import { DEFAULT_UNVERIFIED_SEEK_FLAGS, DEFAULT_VERIFIED_SEEK_FLAGS } from '../../core/bridge/permissionPolicy'

const entry = (over: Record<string, unknown> = {}) => ({
  requestId: 'c1',
  origin: 'https://shop.example',
  attestation: 'unattested' as const,
  transportId: 'loop',
  connectedBefore: false,
  walletRevision: 1,
  profileKey: '0',
  ...over
})

function stub(pending: any[], answer: any) {
  const listeners = new Set<() => void>()
  return {
    listeners,
    store: {
      listPending: () => pending,
      answerConsent: jest.fn().mockResolvedValue(answer),
      onChange: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    }
  }
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  await initBridgeRuntime()
})
afterEach(() => setConsentSheetSource(undefined))

describe('consent sheet source', () => {
  it('follows the store: snapshot changes only when the pending set does', () => {
    const list = [entry()]
    const s = stub(list, undefined)
    expect(getPendingConnections()).toEqual([])
    setConsentSheetSource({ store: s.store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })
    const first = getPendingConnections()
    expect(first).toHaveLength(1)
    expect(getPendingConnections()).toBe(first)
    list.pop()
    s.listeners.forEach(fn => fn())
    expect(getPendingConnections()).toEqual([])
    setConsentSheetSource(undefined)
    expect(s.listeners.size).toBe(0)
  })

  it('describes verified sites with the verified flags and unverified ones with the stricter set', () => {
    expect(connectionFlags('browser')).toEqual(DEFAULT_VERIFIED_SEEK_FLAGS)
    expect(connectionFlags('unattested')).toEqual(
      expect.objectContaining({
        seekBasketInsertionPermissions: DEFAULT_UNVERIFIED_SEEK_FLAGS.seekBasketInsertionPermissions
      })
    )
  })

  it('hands the reconnect token to the transport of each live binding of that origin', async () => {
    publish({
      attestedManager: { wallet: {} as any, signing: {} as any },
      readiness: 'ready',
      network: 'main',
      accountContext: 'ctx'
    })
    const deliver = jest.fn()
    registerTransport({
      id: 'loop',
      attestation: 'unattested',
      bindingMode: 'explicit',
      requestAttention: jest.fn(),
      deliverReconnectToken: deliver
    })
    const reg = getBindingRegistry() as any
    const base = {
      transportId: 'loop',
      attestation: 'unattested',
      continuityKey: 'k',
      accountContext: 'ctx',
      walletRevision: 0
    }
    const mine = reg.connectExplicit({
      ...base,
      epoch: 'e1',
      applicationOrigin: 'https://shop.example',
      instanceId: 'i1',
      launchProofVerified: true
    })
    reg.connectExplicit({
      ...base,
      epoch: 'e2',
      applicationOrigin: 'https://other.example',
      instanceId: 'i2',
      launchProofVerified: true
    })
    const s = stub([entry()], { record: {}, reconnectToken: 'tok' })
    setConsentSheetSource({ store: s.store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })

    await answerConnection('c1', true)

    expect(s.store.answerConsent).toHaveBeenCalledWith('c1', true, { walletRevision: 1, profileKey: '0' })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ epoch: mine.epoch }), 'tok')
  })

  it('does nothing for a request that is no longer pending', async () => {
    const s = stub([], undefined)
    setConsentSheetSource({ store: s.store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })
    await answerConnection('gone', true)
    expect(s.store.answerConsent).not.toHaveBeenCalled()
  })
})
