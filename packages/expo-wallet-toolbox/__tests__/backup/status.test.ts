/* eslint-disable import/first -- jest.mock must be hoisted above the imports it affects */
/**
 * Wallet Check's "have I backed up" read.
 *
 * The real risk this file exists to close: `backupCursor-*` keys are scoped by
 * chain+pseudonym+deviceId, but `deviceId` never changes across a logout/re-import on the
 * same install (see deviceId.ts) — so an unscoped read of "any cursor at all" can answer
 * for a DIFFERENT, departed wallet's leftover cursor rather than the current one.
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
      multiGet: async (keys: string[]) => keys.map(k => [k, store[k] ?? null] as [string, string | null]),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { cursorKey } from '../../core/backup/constants'
import { getBackupUploadState } from '../../core/backup/status'

const PSEUDONYM_A = 'a'.repeat(66)
const PSEUDONYM_B = 'b'.repeat(66)
const DEVICE = 'd'.repeat(32)

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('getBackupUploadState', () => {
  it('XR-009: does not report a wallet backed up using a DIFFERENT identity\'s leftover cursor', async () => {
    // Wallet A pushed a chunk and left its cursor behind (e.g. logout with no sweep).
    // Wallet B is a different identity on the same install/device id, never yet pushed.
    await AsyncStorage.setItem(cursorKey('main', PSEUDONYM_A, DEVICE), JSON.stringify({ seq: 3 }))

    expect((await getBackupUploadState('main', PSEUDONYM_B)).uploaded).toBe(false)
  })

  it('reports uploaded once THIS identity has its own cursor with a real sequence', async () => {
    await AsyncStorage.setItem(cursorKey('main', PSEUDONYM_B, DEVICE), JSON.stringify({ seq: 1 }))

    expect((await getBackupUploadState('main', PSEUDONYM_B)).uploaded).toBe(true)
  })

  it('ignores a same-identity cursor on a different chain', async () => {
    await AsyncStorage.setItem(cursorKey('test', PSEUDONYM_A, DEVICE), JSON.stringify({ seq: 5 }))

    expect((await getBackupUploadState('main', PSEUDONYM_A)).uploaded).toBe(false)
  })

  it('is false for a cursor that exists but has never pushed a real chunk (seq 0)', async () => {
    await AsyncStorage.setItem(cursorKey('main', PSEUDONYM_A, DEVICE), JSON.stringify({ seq: 0 }))

    expect((await getBackupUploadState('main', PSEUDONYM_A)).uploaded).toBe(false)
  })

  it('reports enabled from the ordinary opt-out preference', async () => {
    expect((await getBackupUploadState('main', PSEUDONYM_A)).enabled).toBe(true)
  })

  it('treats an unreadable store as not uploaded rather than throwing', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('boom'))
    expect((await getBackupUploadState('main', PSEUDONYM_A)).uploaded).toBe(false)
    spy.mockRestore()
  })
})
