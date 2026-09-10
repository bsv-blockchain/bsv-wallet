/**
 * ceremonyHost — the process-wide CeremonyController singleton. Wiring only:
 * the controller's behaviour is ceremony.test.ts's business. This proves the
 * host constructs ONE controller with the release constants, a store view
 * that narrows vaultStore's meta v5 to the ceremony's key list, and thin
 * forwarders for requestVaultSigner / noteVaultProgress. The controller is
 * replaced by a recording fake so no driver or card is involved.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
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
jest.mock('../../core/services/vault/ceremony', () => {
  class FakeCeremonyController {
    static instances: FakeCeremonyController[] = []
    deps: unknown
    requestSigner = jest.fn(async (_reason: string, serial: string) => ({
      serial,
      pubkey: '02' + '00'.repeat(32),
      sign: async () => [] as number[],
      release: () => {}
    }))
    noteProgress = jest.fn()
    constructor(deps: unknown) {
      this.deps = deps
      FakeCeremonyController.instances.push(this)
    }
  }
  return { CeremonyController: FakeCeremonyController }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { CeremonyController } from '../../core/services/vault/ceremony'
import { getVaultDriver } from '../../core/services/vault/driver'
import { vaultStore } from '../../core/services/vault/vaultStore'
import {
  VAULT_INPUTS_PER_TAP,
  VAULT_RETENTION_MS,
  ceremony,
  noteVaultProgress,
  requestVaultSigner
} from '../../core/services/vault/ceremonyHost'

interface FakeDeps {
  getDriver: unknown
  store: { getMeta: () => Promise<unknown> }
  retentionMs: number
  inputsPerTap?: number
  attachTimeoutMs?: number
}
interface FakeInstance {
  deps: FakeDeps
  requestSigner: jest.Mock
  noteProgress: jest.Mock
}
const instances = (CeremonyController as unknown as { instances: FakeInstance[] }).instances

beforeEach(async () => {
  await AsyncStorage.clear()
})

test('constants: two-minute retention, sixteen inputs per tap', () => {
  expect(VAULT_RETENTION_MS).toBe(120_000)
  expect(VAULT_INPUTS_PER_TAP).toBe(16)
})

test('constructs exactly one controller, wired to the live driver getter and the release constants', () => {
  expect(instances).toHaveLength(1)
  expect(ceremony).toBe(instances[0])
  const deps = instances[0].deps
  expect(deps.getDriver).toBe(getVaultDriver)
  expect(deps.retentionMs).toBe(VAULT_RETENTION_MS)
  expect(deps.inputsPerTap).toBe(VAULT_INPUTS_PER_TAP)
  expect(deps.attachTimeoutMs).toBeUndefined() // the ceremony's own 65 s default applies
})

test('the store view narrows meta v5 to { keys: [{ serial, slot, pubkey }] } and nothing else', async () => {
  const view = instances[0].deps.store
  expect(await view.getMeta()).toBeNull()

  await vaultStore.setMeta({
    v: 5,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedSerial: '10000002',
    keys: [
      { serial: '10000001', slot: 0x82, pubkey: '02' + 'aa'.repeat(32), nickname: 'Desk', enrolledAt: 1 },
      { serial: '10000002', slot: 0x82, pubkey: '03' + 'bb'.repeat(32), nickname: 'Safe', enrolledAt: 2 }
    ]
  })
  // toEqual, not toMatchObject: nicknames and timestamps must NOT leak into
  // the ceremony's view — it needs serial, slot and pubkey only.
  expect(await view.getMeta()).toEqual({
    keys: [
      { serial: '10000001', slot: 0x82, pubkey: '02' + 'aa'.repeat(32) },
      { serial: '10000002', slot: 0x82, pubkey: '03' + 'bb'.repeat(32) }
    ]
  })
})

test("requestVaultSigner forwards (reason, chosenSerial) and returns the controller's signer", async () => {
  const signer = await requestVaultSigner('Withdraw from vault', '10000002')
  expect(instances[0].requestSigner).toHaveBeenCalledTimes(1)
  expect(instances[0].requestSigner).toHaveBeenCalledWith('Withdraw from vault', '10000002')
  expect(signer.serial).toBe('10000002')
})

test('noteVaultProgress forwards the note verbatim', () => {
  noteVaultProgress({ phase: 'preparing', signed: 3, total: 9 })
  expect(instances[0].noteProgress).toHaveBeenCalledWith({ phase: 'preparing', signed: 3, total: 9 })
  noteVaultProgress({ phase: 'broadcasting' })
  expect(instances[0].noteProgress).toHaveBeenLastCalledWith({ phase: 'broadcasting' })
})
