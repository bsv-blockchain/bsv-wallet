/**
 * INT-08 — VaultContext's `hasVaultMeta` boot-time race against
 * WalletContext's async wallet-build chain.
 *
 * `hasVaultMeta` is computed by an effect whose only dependency was ceremony
 * phase (which never changes on a cold start). On mount it reads
 * vaultStore.isEnrolled(), which needs no native I/O and resolves as soon as
 * the module-level `activeScope` is set — false, synchronously, at every
 * process start. `activeScope` is only ever set later, inside
 * WalletContext's multi-await wallet-build chain, by vaultStore.configureScope().
 * Because VaultProvider mounts at app root in the same tree, its effect is
 * structurally guaranteed to settle `hasVaultMeta = false` before that chain
 * ever reaches configureScope() — and nothing thereafter re-triggers the
 * check, since a ceremony can only run through the very entry points this
 * flag guards.
 *
 * This test drives the REAL VaultContext and the REAL (SecureStore-mocked)
 * vaultStore, not a mocked useVault() — the walletHomeVaultGate.test.tsx
 * suite mocks useVault() directly and so cannot see this race at all.
 */
// Own AsyncStorage mock, matching __tests__/vault/vaultKeyService.test.ts.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => {
        store[k] = v
      },
      removeItem: async (k: string) => {
        delete store[k]
      },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      deleteItemAsync: jest.fn(async (k: string) => {
        delete store[k]
      }),
      __clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  })()
}))

import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { VaultProvider, useVault } from '../../core/context/VaultContext'
import { vaultStore } from '../../core/services/vault/vaultStore'

const IDENTITY = '02' + 'ab'.repeat(32)
const pubkey = (n: number): string => Utils.toHex(Array.from(p256.Point.BASE.multiply(BigInt(n)).toBytes(true)))

function Reader({ onRender }: { onRender: (hasVaultMeta: boolean) => void }) {
  const { hasVaultMeta } = useVault()
  onRender(hasVaultMeta)
  return null
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __clear(): void }).__clear()
  vaultStore.clearScope()
})

afterEach(() => {
  vaultStore.clearScope()
})

test('INT-08: hasVaultMeta becomes true once configureScope runs after mount, not only at mount', async () => {
  // Seed an enrollment under the scope BEFORE it is configured — mirroring a
  // real device that already has a stored vault, reached only once
  // WalletContext's build chain configures the scope.
  vaultStore.configureScope({ identityKey: IDENTITY, chain: 'main' })
  await vaultStore.setMeta({
    v: 6,
    vaultId: '11'.repeat(32),
    revision: 1,
    createdAt: 1,
    keys: [
      { serial: '10000001', slot: 0x82, pubkey: pubkey(1), nickname: 'Desk', enrolledAt: 1 },
      { serial: '10000002', slot: 0x82, pubkey: pubkey(2), nickname: 'Safe', enrolledAt: 2 }
    ]
  })
  // Reproduce the real ordering: VaultProvider mounts (as it does at app
  // root) BEFORE anything has called configureScope for this cold start.
  vaultStore.clearScope()

  let latest = false
  const rendered = render(
    <VaultProvider>
      <Reader onRender={v => (latest = v)} />
    </VaultProvider>
  )

  // At HEAD (still-open) this is already wrong for the wrong reason it stays
  // wrong: the effect's isEnrolled() read resolves false because no scope is
  // configured yet — exactly the real boot-time state.
  expect(latest).toBe(false)

  // The wallet-build chain reaches configureScope() only AFTER further async
  // work has already run past this point (see VaultContext.tsx's header
  // comment) — simulated here with a queued microtask.
  await Promise.resolve()
  vaultStore.configureScope({ identityKey: IDENTITY, chain: 'main' })

  await waitFor(() => {
    expect(latest).toBe(true)
  })

  rendered.unmount()
})
