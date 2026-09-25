/**
 * XQ-014 — the device-wide enrolled-serial registry itself, independent of
 * pivReset.ts's use of it (see pivReset.test.ts for that integration).
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store[k] ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k]
      }),
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      __store: store
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  enrolledSerialRegistry,
  forgetSerialsNoLongerEnrolledForIdentity
} from '../../core/services/vault/enrolledSerialRegistry'

beforeEach(async () => {
  await enrolledSerialRegistry.clearAll()
  jest.clearAllMocks()
})

describe('enrolledSerialRegistry', () => {
  it('has() is false for a serial never recorded', async () => {
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(false)
  })

  it('record() then has() is true, and it never carries pubkeys, nicknames or identity keys — bare serials only', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(true)
    const raw = JSON.parse((AsyncStorage as unknown as { __store: Record<string, string> }).__store['vault_enrolled_serial_registry_v1'])
    expect(raw).toEqual(['MOCK-1'])
  })

  it('record() is idempotent for the same serial', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await enrolledSerialRegistry.record('MOCK-1')
    const raw = JSON.parse((AsyncStorage as unknown as { __store: Record<string, string> }).__store['vault_enrolled_serial_registry_v1'])
    expect(raw).toEqual(['MOCK-1'])
  })

  it('forget() removes exactly one serial and leaves the rest', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await enrolledSerialRegistry.record('MOCK-2')
    await enrolledSerialRegistry.forget('MOCK-1')
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(false)
    expect(await enrolledSerialRegistry.has('MOCK-2')).toBe(true)
  })

  it('forget() on a serial never recorded is a harmless no-op', async () => {
    await expect(enrolledSerialRegistry.forget('MOCK-NEVER')).resolves.toBeUndefined()
    expect(await enrolledSerialRegistry.has('MOCK-NEVER')).toBe(false)
  })

  it('ignores a structurally invalid serial on every operation, never throwing', async () => {
    await expect(enrolledSerialRegistry.record('')).resolves.toBeUndefined()
    await expect(enrolledSerialRegistry.has('')).resolves.toBe(false)
    await expect(enrolledSerialRegistry.forget('')).resolves.toBeUndefined()
  })

  it('a corrupt stored registry is read as empty rather than thrown', async () => {
    ;(AsyncStorage as unknown as { __store: Record<string, string> }).__store['vault_enrolled_serial_registry_v1'] =
      'not json at all'
    await expect(enrolledSerialRegistry.has('MOCK-1')).resolves.toBe(false)
  })

  it('a write failure in record() is swallowed, not thrown — never fails the enrollment it is recording after', async () => {
    ;(AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'))
    await expect(enrolledSerialRegistry.record('MOCK-1')).resolves.toBeUndefined()
  })

  it('clearAll() removes every recorded serial', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await enrolledSerialRegistry.record('MOCK-2')
    await enrolledSerialRegistry.clearAll()
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(false)
    expect(await enrolledSerialRegistry.has('MOCK-2')).toBe(false)
  })
})

describe('forgetSerialsNoLongerEnrolledForIdentity', () => {
  it('forgets a serial the identity-scoped scan no longer reports', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await forgetSerialsNoLongerEnrolledForIdentity(['MOCK-1'], async () => [])
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(false)
  })

  it('keeps a serial still reported by another chain of the SAME identity', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await forgetSerialsNoLongerEnrolledForIdentity(['MOCK-1'], async () => ['MOCK-1'])
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(true)
  })

  it('does nothing for an empty candidate list', async () => {
    const scan = jest.fn(async () => [])
    await forgetSerialsNoLongerEnrolledForIdentity([], scan)
    expect(scan).not.toHaveBeenCalled()
  })

  it('fails closed (keeps every candidate registered) when the cross-chain scan itself fails', async () => {
    await enrolledSerialRegistry.record('MOCK-1')
    await forgetSerialsNoLongerEnrolledForIdentity(['MOCK-1'], async () => {
      throw new Error('scope-changed')
    })
    expect(await enrolledSerialRegistry.has('MOCK-1')).toBe(true)
  })
})
