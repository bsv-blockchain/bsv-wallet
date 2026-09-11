import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
let mockState: Record<string, unknown> = { phase: 'idle' }
let mockMeta: unknown = null
const mockRetry = jest.fn()
const mockCancel = jest.fn()

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  useVault: () => ({ state: mockState, submitPin: jest.fn(), cancel: mockCancel, retry: mockRetry }),
  vaultStore: { getMeta: async () => mockMeta },
  VAULT_INPUTS_PER_TAP: 16,
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/Sheet', () => {
  const React = require('react')
  return { __esModule: true, default: ({ visible, children }: any) => (visible ? React.createElement(React.Fragment, null, children) : null) }
})
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})

import { VaultCeremonySheet } from '../../ui/components/vault/VaultCeremonySheet'

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = {
    v: 5,
    createdAt: 1,
    keys: [
      { serial: '12340001', slot: 0x82, pubkey: '02' + 'a'.repeat(64), nickname: 'Desk', enrolledAt: 1 },
      { serial: '12340002', slot: 0x82, pubkey: '02' + 'b'.repeat(64), nickname: 'Safe', enrolledAt: 2 }
    ]
  }
})

test('hidden while idle and while armed', async () => {
  mockState = { phase: 'idle' }
  const a = render(<VaultCeremonySheet />)
  await settle()
  expect(a.queryByText('vault_title')).toBeNull()
  mockState = { phase: 'armed', armedUntil: Date.now() + 1000 }
  const b = render(<VaultCeremonySheet />)
  await settle()
  expect(b.queryByText('vault_unlocking_funds')).toBeNull()
})

test('preparing shows the signing progress line from state.progress', async () => {
  mockState = { phase: 'preparing', reason: 'Withdraw 50,000 sats from vault', progress: { signed: 3, total: 20 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_unlocking_funds')).toBeTruthy()
  expect(screen.getByText('vault_sign_progress:{"signed":3,"total":20}')).toBeTruthy()
  expect(screen.queryByText('vault_unlocking_sub')).toBeNull()
})

test('preparing without progress keeps the generic busy line', async () => {
  mockState = { phase: 'preparing' }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_unlocking_sub')).toBeTruthy()
})

test('waiting for the next batch says which batch of how many', async () => {
  mockState = { phase: 'waiting-for-key', progress: { signed: 16, total: 40 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_nfc_sign_batch:{"b":2,"n":3}')).toBeTruthy()
  expect(screen.getByText('vault_sign_progress:{"signed":16,"total":40}')).toBeTruthy()
})

test('the first tap has no batch line', async () => {
  mockState = { phase: 'waiting-for-key', progress: { signed: 0, total: 40 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.queryByText(/vault_nfc_sign_batch/)).toBeNull()
})

test('a retryable error offers Try again and routes it to retry()', async () => {
  mockState = { phase: 'error', error: { code: 'nfc-lost' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_nfc_lost')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_retry'))
  expect(mockRetry).toHaveBeenCalledTimes(1)
})

test('a hard error has Dismiss only', async () => {
  mockState = { phase: 'error', error: { code: 'pin-locked' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_pin_locked')).toBeTruthy()
  expect(screen.queryByText('vault_retry')).toBeNull()
  fireEvent.press(screen.getByText('vault_dismiss'))
  expect(mockCancel).toHaveBeenCalledTimes(1)
})

test('serial-mismatch names the vault keys read from meta', async () => {
  mockState = { phase: 'error', error: { code: 'serial-mismatch' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}')).toBeTruthy()
})

test('serial-mismatch with no meta falls back to the plain wrong-key line', async () => {
  mockMeta = null
  mockState = { phase: 'error', error: { code: 'serial-mismatch' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_wrong_key')).toBeTruthy()
})

test('a wrong PIN shows the attempts left under the error', async () => {
  mockState = { phase: 'error', error: { code: 'pin-invalid', retriesLeft: 2 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_pin_invalid_retry:{"count":2}')).toBeTruthy()
})
