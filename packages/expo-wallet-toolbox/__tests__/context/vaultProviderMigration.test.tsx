/**
 * VaultProvider removes the K1-era SecureStore seal once, on mount (spec
 * §3.2). Everything else the provider touches is mocked away: the point is
 * the single migrateLegacySeal() call, not the ceremony wiring.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en', languageTag: 'en-US' }] }))
jest.mock('../../core/hooks/useConfirmationSound', () => ({
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() }
}))
jest.mock('../../core/hooks/useHaptics', () => ({
  haptics: { success: jest.fn(), confirm: jest.fn() }
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  ceremony: {
    state: { phase: 'idle' },
    subscribe: (cb: (s: unknown) => void) => {
      cb({ phase: 'idle' })
      return () => {}
    },
    submitPin: jest.fn(),
    cancel: jest.fn(),
    retry: jest.fn()
  }
}))

import React from 'react'
import { act, create } from 'react-test-renderer'
import * as SecureStore from 'expo-secure-store'
import { VaultProvider } from '../../core/context/VaultContext'

test('VaultProvider deletes vault_seal_v1 once on mount', async () => {
  await act(async () => {
    create(
      <VaultProvider>
        <></>
      </VaultProvider>
    )
  })
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1)
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('vault_seal_v1')
})
