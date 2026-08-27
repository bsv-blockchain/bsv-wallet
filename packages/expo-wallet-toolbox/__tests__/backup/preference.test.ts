/* eslint-disable import/first -- jest.mock must be hoisted above the imports it affects */
/**
 * The backup-push opt-out.
 *
 * The default is the whole point: a wallet that silently stops backing up because a flag
 * was missing, or because a read failed, is the failure this feature exists to prevent.
 * Only an explicit opt-out written by the user turns pushing off.
 */
// Own AsyncStorage mock, matching erase.test.ts/push.test.ts: the vault suites install a
// different one and a global mapper makes the resolver recurse between the two.
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

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  BACKUP_PUSH_ENABLED_KEY,
  isBackupPushEnabled,
  setBackupPushEnabled
} from '../../core/backup/preference'

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('backup push preference', () => {
  it('is on for a wallet that has never touched the setting', async () => {
    expect(await isBackupPushEnabled()).toBe(true)
  })

  it('persists an opt-out and an opt-back-in', async () => {
    await setBackupPushEnabled(false)
    expect(await isBackupPushEnabled()).toBe(false)

    await setBackupPushEnabled(true)
    expect(await isBackupPushEnabled()).toBe(true)
  })

  it('stores the opt-out explicitly rather than by absence', async () => {
    // Absence must mean "on", so "off" needs a value of its own on disk. Clearing the key
    // is how the setting returns to its default, not how it is turned off.
    await setBackupPushEnabled(false)
    expect(await AsyncStorage.getItem(BACKUP_PUSH_ENABLED_KEY)).toBe('false')

    await AsyncStorage.removeItem(BACKUP_PUSH_ENABLED_KEY)
    expect(await isBackupPushEnabled()).toBe(true)
  })

  it('stays on when the store throws', async () => {
    // A failed read must not be mistaken for an opt-out: the user would lose their backup
    // and never be told.
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('boom'))
    expect(await isBackupPushEnabled()).toBe(true)
    spy.mockRestore()
  })

  it('treats an unrecognised stored value as on', async () => {
    await AsyncStorage.setItem(BACKUP_PUSH_ENABLED_KEY, 'maybe')
    expect(await isBackupPushEnabled()).toBe(true)
  })
})
